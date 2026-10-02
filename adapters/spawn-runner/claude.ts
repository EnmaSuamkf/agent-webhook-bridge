/**
 * Spawn adapter for Claude Code.
 *
 * Launch rule: if the inbound webhook request carried a `sessionId` header,
 * resume that session (`claude --resume <sessionId> -p "<prompt>"`); otherwise
 * start a fresh one (`claude -p "<prompt>" --output-format json`). This lets
 * a single hook either re-wake an existing conversation or kick off a new
 * one, depending on what the caller sends — no separate hook config needed.
 *
 * Process lifecycle (hidden/visible run, log file, stdout capture) lives in
 * ./shared.ts so it's shared verbatim with the free-code adapter; this file
 * only owns the claude-specific argv and the `--output-format` choice.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logsDir } from "../../broker/config.ts";
import type { HookConfig } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";
import { wrapForSandbox } from "./sandbox.ts";
import { commandHeader, renderPrompt, runHidden, runVisible, type RunResult, type SpawnHook, type StartedHook } from "./shared.ts";

/** Alias kept so external callers that imported the old name keep compiling. */
export type ClaudeRunResult = RunResult;

const BINARY = "claude";

export function runClaude(hook: HookConfig, event: WebhookEvent, onSpawn?: SpawnHook, onStarted?: StartedHook): Promise<RunResult> {
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

	// Last step before spawning: a hook with a `sandbox` block gets this exact
	// argv re-expressed as `docker run --rm … claude …`; without one the pair
	// comes back untouched. The `cwd` is deliberately NOT rewritten — the run
	// still starts from the host workdir, which is where the flock, the log
	// file and (via the identical bind-mount path) the transcripts live.
	const run = wrapForSandbox(BINARY, args, hook);

	if (hook.visible) return runVisible(run.args, run.binary, cwd, mode, logFile, onSpawn, onStarted, run.env);

	// Hidden mode: Node owns the log file directly, so the header is written
	// here up front (there's no terminal shell to print its own).
	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	logStream.write(`${commandHeader(run.binary, run.args, (a) => (a === prompt ? JSON.stringify(a) : a))}\ncwd: ${cwd}\n\n`);
	return runHidden(run.args, run.binary, cwd, mode, logFile, logStream, onSpawn, onStarted, run.env);
}
