/**
 * Shared spawn plumbing for the spawn-runner adapters (claude, free-code, cursor, copilot).
 *
 * Each adapter builds its own argv (binary + flags) and hands it here to run
 * it either hidden (stdout piped to a log file and captured in memory) or in
 * a visible gnome-terminal window. Adapters keep their result-parsing /
 * session-handling specifics; this module only owns the process lifecycle,
 * the log file, and the visible/hidden fallback — so the spawn adapters don't
 * drift apart on the parts that are identical between CLIs.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { bridgeDir, type HookConfig } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";

/**
 * Common shape every spawn adapter returns. `dispatch.callbackPayload` lifts
 * `result`/`session_id` out of `stdout` uniformly, so adapters whose CLI
 * emits a different stream (free-code's NDJSON or copilot's JSONL, not
 * claude's single JSON envelope) reshape their stdout into a `{result, session_id}` object before
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
	/**
	 * Captured stderr of the spawned run (tail only, see MAX_STDERR_CAPTURE).
	 *
	 * This is where a CLI says WHY it died — "Prompt is too long", a bad flag, a
	 * missing credential — and until it was captured here none of that reached
	 * the caller: `dispatch.callbackPayload` only ever forwarded `ok`/`exitCode`,
	 * so every failure, including a context overflow, arrived at the hub as a
	 * bare `exit 1`. Still piped to the log file exactly as before; this is a
	 * copy, not a redirect. Absent in visible mode (stderr goes through `tee` in
	 * the terminal, not through this process) and on spawn errors.
	 */
	stderr?: string;
}

// Callback payloads only need the result JSON (a few KB); cap the in-memory
// capture so a runaway run can't balloon the broker's heap. The log file
// still gets everything regardless.
const MAX_STDOUT_CAPTURE = 4 * 1024 * 1024;

/**
 * stderr is only ever used as an error message, so a much smaller cap than
 * stdout's — and it's the TAIL that's kept, not the head: a CLI prints its
 * progress chatter first and its fatal error last, so the last 8KB is the part
 * that says what went wrong.
 */
const MAX_STDERR_CAPTURE = 8 * 1024;

/**
 * `flock` (util-linux) binary, located once at module load. Hidden runs wrap
 * the spawn in `flock <lockfile> bash -c '… exec "$@"' bash <binary> <args>`
 * so the workdir lock is held by the agent process itself (via the inherited
 * fd), which means it SURVIVES a broker restart: an orphaned child from a dead
 * broker keeps holding the lock, and a new broker's run for the same workdir
 * blocks on it until the orphan exits — the in-memory `workdirChains` queue in
 * dispatch.ts can't give that guarantee on its own. null on platforms without
 * `flock` (then we fall back to an unwrapped spawn, i.e. no cross-restart
 * serialization — same as the pre-flock behaviour, never worse). Visible mode
 * is left unwrapped on purpose (see `runVisible`).
 */
const FLOCK = ["/usr/bin/flock", "/bin/flock", "/usr/local/bin/flock"].find((p) => {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}) ?? null;

/**
 * Marker the hidden-mode wrapper writes to fd 3 the instant `flock` has
 * acquired the workdir lock (right before `exec`-ing the agent binary). The
 * broker reads it off fd 3 to fire the `started` callback at the true moment
 * the run begins — NOT at spawn time, which would be too early when the run is
 * queued behind another on the same workdir. Kept short and unique enough that
 * a coincidental match in the binary's own (separate) stdout stream is not a
 * concern: this only travels on fd 3, which the binary never writes to.
 */
const STARTED_MARKER = "AWB_STARTED\n";

/**
 * `echo <marker> >&3; exec 3>&-; exec "$@"` — print the marker, close fd 3, replace with the agent binary.
 * No redirection of stderr on the `exec`s: on a bare `exec` it is permanent and would send the
 * agent's own stderr (its error message) to /dev/null.
 */
const HIDDEN_STARTED_SCRIPT = `echo ${STARTED_MARKER.trim()} >&3 2>/dev/null; exec 3>&-; exec "$@"`;

/**
 * Persistent workdir lock file for `cwd`. Kept OUTSIDE the workdir (under
 * `~/.agent-webhook-bridge/locks/<sha1(cwd)>.lock`) so it never pollutes a
 * real repo's working tree, while still keying on the absolute cwd so two
 * hooks on the same workdir share a lockfile and two on different workdirs
 * get distinct ones.
 */
function lockFileFor(cwd: string): string {
	const hash = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16);
	const dir = path.join(bridgeDir(), "locks");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${hash}.lock`);
}

/**
 * Builds the prompt string from the hook's template and the event body.
 * `callbackUrl`, `startedCallbackUrl` and `jobId` are broker plumbing
 * (consumed by dispatch to report the result / the run's start / to abort),
 * not task content — leaving them in {{payload}} makes the spawned agent try
 * to POST them itself or quote them back, and headless runs can't.
 */
export function renderPrompt(hook: HookConfig, event: WebhookEvent): string {
	let body = event.body;
	if (typeof body === "object" && body !== null) {
		const { callbackUrl: _, startedCallbackUrl: __, jobId: ___, ...rest } = body as Record<string, unknown>;
		body = rest;
	}
	const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
	const template = hook.promptTemplate ?? "Incoming webhook event for '{{hook}}':\n\n{{payload}}";
	return template.replaceAll("{{payload}}", payload).replaceAll("{{hook}}", event.hook);
}

/** Notified once the spawned process group leader exists (its pid), so dispatch can register it for abort. */
export type SpawnHook = (pid: number) => void;

/** Notified when the run has actually begun — for hidden runs with `flock`, that's after the workdir lock is acquired (the fd-3 marker), not at spawn. */
export type StartedHook = () => void;

/**
 * Runs `binary args` hidden, stdout/stderr piped straight to the log file.
 * `logStream` is opened by the caller so it can write a header line first;
 * this function closes it when the process exits. The captured stdout (up to
 * MAX_STDOUT_CAPTURE bytes) is returned for the adapter to reshape/forward.
 *
 * When `flock` is available the spawn is wrapped in
 * `flock <lockfile> bash -c 'echo AWB_STARTED >&3; exec 3>&-; exec "$@"' bash <binary> <args>`:
 * `flock` holds the workdir lock for the run's lifetime (surviving broker
 * restarts), `bash` writes the STARTED marker to fd 3 once the lock is held,
 * then `exec` replaces it with the agent binary (args forwarded literally via
 * `"$@"`, so attacker-controlled prompt text is never interpreted by a shell).
 * The child runs `detached` in its own process group so `process.kill(-pid)`
 * reaches `flock`+`bash`+the binary together — that's what frees the workdir
 * on abort. `onSpawn` fires at spawn (the flock pid, = the group leader);
 * `onStarted` fires when the fd-3 marker arrives (the real run start).
 */
export function runHidden(
	args: string[],
	binary: string,
	cwd: string,
	mode: "resume" | "new",
	logFile: string,
	logStream: fs.WriteStream,
	onSpawn?: SpawnHook,
	onStarted?: StartedHook,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const useFlock = FLOCK !== null;
		const lockfile = useFlock ? lockFileFor(cwd) : null;
		// fd layout when wrapped: 0 ignore, 1 stdout (binary), 2 stderr (binary),
		// 3 the STARTED marker pipe (bash writes once, then closes before exec).
		const stdio: Array<"ignore" | "pipe"> = useFlock ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
		const child = useFlock
			? spawn(FLOCK as string, [lockfile as string, "bash", "-c", HIDDEN_STARTED_SCRIPT, "bash", binary, ...args], {
					cwd,
					stdio,
					detached: true,
				})
			: spawn(binary, args, { cwd, stdio, detached: true });
		onSpawn?.(child.pid as number);

		if (useFlock) {
			const startedPipe = child.stdio[3] as unknown as
				| { on(event: "data", listener: (chunk: Buffer) => void): unknown; once?(event: "close", listener: () => void): unknown }
				| null;
			let fired = false;
			const fireStarted = (): void => {
				if (!fired) {
					fired = true;
					onStarted?.();
				}
			};
			startedPipe?.on("data", (chunk: Buffer) => {
				if (chunk.toString("utf8").includes(STARTED_MARKER.trim())) fireStarted();
			});
			// If `flock` exits before emitting a marker (e.g. it couldn't acquire the
			// lock and errored), `close` still settles the run below; no stale start.
		} else if (onStarted) {
			// No flock → no lock to wait on; the binary starts right away.
			onStarted();
		}

		const stdoutChunks: Buffer[] = [];
		let stdoutSize = 0;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutSize >= MAX_STDOUT_CAPTURE) return;
			stdoutChunks.push(chunk);
			stdoutSize += chunk.length;
		});
		// Keep a rolling tail of stderr: append, then drop from the front once over
		// the cap, so a chatty run that dies at the end still yields its last words
		// without the broker holding the whole stream.
		const stderrChunks: Buffer[] = [];
		let stderrSize = 0;
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
			stderrSize += chunk.length;
			while (stderrSize > MAX_STDERR_CAPTURE && stderrChunks.length > 1) {
				stderrSize -= (stderrChunks.shift() as Buffer).length;
			}
		});
		child.stdout?.pipe(logStream, { end: false });
		child.stderr?.pipe(logStream, { end: false });
		child.on("close", (exitCode) => {
			logStream.end();
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			resolve({ ok: exitCode === 0, mode, exitCode, logFile, stdout, stderr });
		});
		child.on("error", (err) => {
			const message = `spawn error: ${String(err)}`;
			logStream.write(`\n${message}\n`);
			logStream.end();
			// The spawn never produced a stream, so this IS the run's error text —
			// report it as stderr rather than leaving the caller with a null exit code
			// and no explanation.
			resolve({ ok: false, mode, exitCode: null, logFile, stderr: message });
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
 *
 * Visible mode is NOT wrapped in `flock`: it's an interactive, operator-watched
 * path where cross-restart serialization doesn't apply (a visible window from a
 * dead broker is already gone), and gnome-terminal's fork behaviour would
 * release an outer lock early. Serialization within one broker still holds via
 * dispatch's in-memory `workdirChains`. `onSpawn` fires at spawn (the
 * gnome-terminal pid, for abort); `onStarted` fires at spawn too (best-effort —
 * visible mode can't observe lock acquisition the way the fd-3 marker does for
 * hidden runs, and visible runs aren't the contended-workdir bug).
 */
export function runVisible(
	args: string[],
	binary: string,
	cwd: string,
	mode: "resume" | "new",
	logFile: string,
	onSpawn?: SpawnHook,
	onStarted?: StartedHook,
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
			{ cwd, env: { ...process.env, AWB_LOGFILE: logFile }, stdio: "ignore", detached: true },
		);
		onSpawn?.(child.pid as number);
		// Best-effort: visible mode has no fd-3 channel back, so report start at
		// spawn time. The contended-workdir fairness fix (option c) targets the
		// hidden dispatch path; visible runs are interactive and operator-paced.
		onStarted?.();
		child.on("close", (exitCode) => {
			resolve({ ok: exitCode === 0, mode, exitCode, logFile });
		});
		child.on("error", (err) => {
			const logStream = fs.createWriteStream(logFile, { flags: "a" });
			logStream.write(`gnome-terminal unavailable (${String(err)}), falling back to hidden run\n`);
			logStream.write(`$ ${binary} ${args.join(" ")}\ncwd: ${cwd}\n\n`);
			runHidden(args, binary, cwd, mode, logFile, logStream, onSpawn, onStarted).then(resolve);
		});
	});
}
