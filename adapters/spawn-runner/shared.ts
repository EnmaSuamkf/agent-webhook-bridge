/**
 * Shared spawn plumbing for the spawn-runner adapters (claude, free-code, …).
 *
 * Each adapter builds its own argv (binary + flags) and hands it here to run
 * it either hidden (stdout piped to a log file and captured in memory) or in
 * a visible gnome-terminal window. Adapters keep their result-parsing /
 * session-handling specifics; this module only owns the process lifecycle,
 * the log file, and the visible/hidden fallback — so the two adapters don't
 * drift apart on the parts that are identical between CLIs.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { HookConfig } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";

/**
 * Common shape every spawn adapter returns. `dispatch.callbackPayload` lifts
 * `result`/`session_id` out of `stdout` uniformly, so adapters whose CLI
 * emits a different stream (free-code's NDJSON, not claude's single JSON
 * envelope) reshape their stdout into a `{result, session_id}` object before
 * returning — the broker/hub side then stays adapter-agnostic.
 */
export interface RunResult {
	ok: boolean;
	mode: "resume" | "new";
	exitCode: number | null;
	logFile: string;
	/**
	 * Captured stdout of the spawned run. For claude this is the
	 * `--output-format json` blob; for free-code it's already the reshaped
	 * `{result, session_id}` envelope. Absent in visible mode (stdout goes to
	 * the terminal via `tee`, not through this process) and on spawn errors.
	 */
	stdout?: string;
}

// Callback payloads only need the result JSON (a few KB); cap the in-memory
// capture so a runaway run can't balloon the broker's heap. The log file
// still gets everything regardless.
const MAX_STDOUT_CAPTURE = 4 * 1024 * 1024;

/**
 * Builds the prompt string from the hook's template and the event body.
 * `callbackUrl` is broker plumbing (consumed by dispatch to report the
 * result), not task content — leaving it in {{payload}} makes the spawned
 * agent try to POST it itself, and headless runs can't.
 */
export function renderPrompt(hook: HookConfig, event: WebhookEvent): string {
	let body = event.body;
	if (typeof body === "object" && body !== null && "callbackUrl" in body) {
		const { callbackUrl: _, ...rest } = body as Record<string, unknown>;
		body = rest;
	}
	const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
	const template = hook.promptTemplate ?? "Incoming webhook event for '{{hook}}':\n\n{{payload}}";
	return template.replaceAll("{{payload}}", payload).replaceAll("{{hook}}", event.hook);
}

/**
 * Runs `binary args` hidden, stdout/stderr piped straight to the log file.
 * `logStream` is opened by the caller so it can write a header line first;
 * this function closes it when the process exits. The captured stdout (up to
 * MAX_STDOUT_CAPTURE bytes) is returned for the adapter to reshape/forward.
 */
export function runHidden(
	args: string[],
	binary: string,
	cwd: string,
	mode: "resume" | "new",
	logFile: string,
	logStream: fs.WriteStream,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		let stdoutSize = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdoutSize >= MAX_STDOUT_CAPTURE) return;
			stdoutChunks.push(chunk);
			stdoutSize += chunk.length;
		});
		child.stdout.pipe(logStream, { end: false });
		child.stderr.pipe(logStream, { end: false });
		child.on("close", (exitCode) => {
			logStream.end();
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			resolve({ ok: exitCode === 0, mode, exitCode, logFile, stdout });
		});
		child.on("error", (err) => {
			logStream.write(`\nspawn error: ${String(err)}\n`);
			logStream.end();
			resolve({ ok: false, mode, exitCode: null, logFile });
		});
	});
}

// Prints a `$ <binary> …`/`cwd: …` header (each arg shell-quoted with `%q`
// for readability -- purely cosmetic, not re-parsed as shell code), then runs
// "$@" itself. The whole block is piped through `tee` together so the header
// and the run's own output both land in the terminal *and* the log file,
// instead of the header only ever reaching the file (Node writing it before
// the terminal even opens, as the hidden-mode header below does).
const VISIBLE_SCRIPT =
	'{ printf "$"; printf " %q" "$@"; echo; echo "cwd: $PWD"; echo; "$@"; } 2>&1 | tee -a "$AWB_LOGFILE"; ' +
	'ec="${PIPESTATUS[0]}"; echo; echo "--- done (exit $ec) -- press Enter to close ---"; read -r; exit "$ec"';

/**
 * Runs `binary args` in a visible gnome-terminal window (`--wait` so we still
 * block on and learn the real exit code) so a person can read what it did, in
 * addition to capturing it to the log file. Only `--output-format
 * stream-json` actually streams token-by-token -- `text` (like `json`)
 * prints once when the turn is done, so the window pauses on a keypress
 * afterward instead of closing immediately; without that pause it's just a
 * blank window that flashes the result and vanishes before it's readable.
 * `args` are forwarded to the inner `bash -c` as literal argv entries (via
 * `$@`), never interpolated into the shell script string -- an
 * attacker-controlled prompt containing `` ` ``/`$()`/`;` etc. is inert data,
 * not executed. Falls back to `runHidden` if gnome-terminal isn't installed.
 */
export function runVisible(
	args: string[],
	binary: string,
	cwd: string,
	mode: "resume" | "new",
	logFile: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(
			"gnome-terminal",
			[
				"--wait",
				`--working-directory=${cwd}`,
				"--",
				"bash",
				"-c",
				VISIBLE_SCRIPT,
				"bash",
				binary,
				...args,
			],
			{ cwd, env: { ...process.env, AWB_LOGFILE: logFile }, stdio: "ignore" },
		);
		child.on("close", (exitCode) => {
			resolve({ ok: exitCode === 0, mode, exitCode, logFile });
		});
		child.on("error", (err) => {
			const logStream = fs.createWriteStream(logFile, { flags: "a" });
			logStream.write(`gnome-terminal unavailable (${String(err)}), falling back to hidden run\n`);
			logStream.write(`$ ${binary} ${args.join(" ")}\ncwd: ${cwd}\n\n`);
			runHidden(args, binary, cwd, mode, logFile, logStream).then(resolve);
		});
	});
}
