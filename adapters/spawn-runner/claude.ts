/**
 * Spawn adapter for Claude Code — the "universal" (process-spawn) delivery
 * path from PLAN.md section 4.4, restricted to Claude Code for now.
 *
 * Launch rule: if the inbound webhook request carried a `sessionId` header,
 * resume that session (`claude --resume <sessionId> "<prompt>"`); otherwise
 * start a fresh one (`claude -p "<prompt>" --output-format json`). This lets
 * a single hook either re-wake an existing conversation or kick off a new
 * one, depending on what the caller sends — no separate hook config needed.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logsDir } from "../../broker/config.ts";
import type { HookConfig } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";

export interface ClaudeRunResult {
	ok: boolean;
	mode: "resume" | "new";
	exitCode: number | null;
	logFile: string;
	/**
	 * Claude's stdout (the `--output-format json` blob), captured so dispatch
	 * can forward the result to a caller-provided `callbackUrl`. Absent in
	 * visible mode, where stdout goes to the terminal via `tee` instead of
	 * through this process.
	 */
	stdout?: string;
}

// Callback payloads only need the result JSON (a few KB); cap the in-memory
// capture so a runaway run can't balloon the broker's heap. The log file
// still gets everything regardless.
const MAX_STDOUT_CAPTURE = 4 * 1024 * 1024;

function renderPrompt(hook: HookConfig, event: WebhookEvent): string {
	// `callbackUrl` is broker plumbing (consumed by dispatch to report the
	// result), not task content — leaving it in {{payload}} makes the spawned
	// agent try to POST it itself, and headless runs can't.
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
 * Runs `claude` hidden, stdout/stderr piped straight to the log file. Used
 * for every hook by default, and as the fallback when `hook.visible` is set
 * but no supported terminal emulator is installed.
 */
function runHidden(
	args: string[],
	cwd: string,
	mode: "resume" | "new",
	logFile: string,
	logStream: fs.WriteStream,
): Promise<ClaudeRunResult> {
	return new Promise((resolve) => {
		const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

// Prints a `$ claude ...`/`cwd: ...` header (each arg shell-quoted with `%q`
// for readability -- purely cosmetic, not re-parsed as shell code), then runs
// "$@" itself. The whole block is piped through `tee` together so the header
// and the run's own output both land in the terminal *and* the log file,
// instead of the header only ever reaching the file (Node writing it before
// the terminal even opens, as the hidden-mode header below does).
const VISIBLE_SCRIPT =
	'{ printf "$"; printf " %q" "$@"; echo; echo "cwd: $PWD"; echo; "$@"; } 2>&1 | tee -a "$AWB_LOGFILE"; ' +
	'ec="${PIPESTATUS[0]}"; echo; echo "--- done (exit $ec) -- press Enter to close ---"; read -r; exit "$ec"';

/**
 * Runs `claude` in a visible gnome-terminal window (`--wait` so we still
 * block on and learn the real exit code) so a person can read what it did,
 * in addition to capturing it to the log file. Only `--output-format
 * stream-json` actually streams token-by-token -- `text` (like `json`)
 * prints once when the turn is done, so the window pauses on a keypress
 * afterward instead of closing immediately; without that pause it's just a
 * blank window that flashes the result and vanishes before it's readable.
 * `args` are forwarded to the inner `bash -c` as literal argv entries (via
 * `$@`), never interpolated into the shell script string -- an
 * attacker-controlled prompt containing `` ` ``/`$()`/`;` etc. is inert data,
 * not executed. Falls back to `runHidden` if gnome-terminal isn't installed.
 */
function runVisible(args: string[], cwd: string, mode: "resume" | "new", logFile: string): Promise<ClaudeRunResult> {
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
				"claude",
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
			logStream.write(`$ claude ${args.join(" ")}\ncwd: ${cwd}\n\n`);
			runHidden(args, cwd, mode, logFile, logStream).then(resolve);
		});
	});
}

export function runClaude(hook: HookConfig, event: WebhookEvent): Promise<ClaudeRunResult> {
	const prompt = renderPrompt(hook, event);
	const sessionId = event.headers.sessionid;
	const mode: "resume" | "new" = sessionId ? "resume" : "new";
	// `--resume` alone opens the interactive picker (no TTY in a spawned
	// child => hangs). `-p`/`--print` is required to make it headless too.
	// `text` is used instead of `json` when visible so the terminal shows
	// Claude's plain-language result instead of a raw JSON blob (the pause
	// in runVisible is what actually makes it readable before the window
	// closes -- neither format streams token-by-token, only stream-json does).
	const outputFormat = hook.visible ? "text" : "json";
	const args = sessionId
		? ["--resume", sessionId, "-p", prompt, "--output-format", outputFormat]
		: ["-p", prompt, "--output-format", outputFormat];
	// Headless runs have no TTY to answer a permission prompt, so any
	// Write/Edit/Bash the model attempts is auto-denied unless the hook opts
	// into a permission mode explicitly.
	if (hook.permissionMode) args.push("--permission-mode", hook.permissionMode);

	const cwd = hook.workdir ?? process.cwd();
	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${event.hook}-${Date.now()}.log`);

	if (hook.visible) return runVisible(args, cwd, mode, logFile);

	// Hidden mode: Node owns the log file directly, so the header is written
	// here up front (there's no terminal shell to print its own).
	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	logStream.write(`$ claude ${args.map((a) => (a === prompt ? JSON.stringify(a) : a)).join(" ")}\ncwd: ${cwd}\n\n`);
	return runHidden(args, cwd, mode, logFile, logStream);
}
