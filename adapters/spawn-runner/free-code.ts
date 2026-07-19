/**
 * Spawn adapter for free-code (https://github.com/EnmaSuamkf/free-code), the
 * other headless-capable coding agent this broker can wake. Same shape as
 * the claude adapter (hidden/visible run, log file, result callback) but
 * adapted to free-code's CLI and session model:
 *
 * - Output: free-code has no `--output-format json` single-envelope mode.
 *   `--mode json` emits an NDJSON event stream (a session header line, then
 *   one event per message/turn/tool). We capture it and reshape it into the
 *   `{result, session_id}` envelope `dispatch.callbackPayload` already
 *   expects from the claude adapter — so the broker/hub side stays uniform.
 *   Visible mode uses `--mode text` for a readable terminal transcript, and
 *   (like claude visible) carries no `result` in the callback.
 *
 * - Sessions: free-code resumes by .jsonl **path** (`--session <path>`), not
 *   by a uuid string like claude. So the `session_id` we return in the
 *   callback *is* that absolute path, and the caller (e.g. the AgentMesh hub)
 *   just round-trips it back as the `sessionId` header to continue the chain
 *   — same protocol as claude, the value happens to be a path. New runs get a
 *   path under `~/.agent-webhook-bridge/sessions/<hook>/`; a `sessionId`
 *   header that doesn't resolve under that directory is ignored
 *   (path-traversal guard) and a fresh session starts instead.
 *
 * - Permissions: free-code exposes tool access via `--tools`/`--no-tools`,
 *   not a `--permission-mode` flag. We map the hook's `permissionMode`
 *   (claude-style) to a tool set so one hook config works across both
 *   adapters:
 *       unset              → read-only (read,grep,find,ls) — the AgentMesh default
 *       acceptEdits        → read,edit,write,grep,find,ls  (no bash)
 *       bypass/auto/dontAsk → full incl. bash (dangerous, same risk as claude)
 *       manual/plan        → read-only (a spawned run has no TTY to confirm)
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { bridgeDir, logsDir, type HookConfig, type PermissionMode } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";
import { renderPrompt, runHidden, runVisible, type RunResult } from "./shared.ts";

const BINARY = "free-code";

/** Root directory the adapter stores free-code session .jsonl files under. */
const SESSIONS_BASE = path.join(bridgeDir(), "sessions");

/** Maps the hook's claude-style `permissionMode` to free-code `--tools` flags. */
export function toolsArgs(permissionMode: PermissionMode | undefined): string[] {
	switch (permissionMode) {
		case undefined:
			// AgentMesh safe default: the agent answers but can't mutate or exec.
			// free-code has no runtime auto-deny, so we simply don't expose those tools.
			return ["--tools", "read,grep,find,ls"];
		case "acceptEdits":
			// File writes/edits in the sandbox without a prompt; no bash.
			return ["--tools", "read,edit,write,grep,find,ls"];
		case "bypassPermissions":
		case "auto":
		case "dontAsk":
			// No guardrails, bash included. Same risk profile as claude's bypass.
			return ["--tools", "read,bash,edit,write,grep,find,ls"];
		case "manual":
		case "plan":
			// claude would prompt; a spawned run has no TTY, so read-only it is.
			return ["--tools", "read,grep,find,ls"];
	}
}

/**
 * Picks the .jsonl path to run with. A `sessionId` header (a path we returned
 * in a previous callback) resumes that exact file; otherwise we mint a new
 * path under `~/.agent-webhook-bridge/sessions/<hook>/`. A header that points
 * outside SESSIONS_BASE is treated as untrusted and a new session starts.
 */
export function sessionPath(hook: string, sessionIdHeader: string | undefined): { file: string; mode: "resume" | "new" } {
	if (sessionIdHeader) {
		const resolved = path.resolve(sessionIdHeader);
		const rel = path.relative(SESSIONS_BASE, resolved);
		// `rel` is "" when resolved === SESSIONS_BASE, and starts with ".." (or is
		// absolute on Windows) when resolved is outside the sessions dir.
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			return { file: resolved, mode: "resume" };
		}
		// Outside our sessions dir → don't trust it, start fresh.
	}
	const dir = path.join(SESSIONS_BASE, hook);
	fs.mkdirSync(dir, { recursive: true });
	return { file: path.join(dir, `${Date.now()}-${crypto.randomUUID()}.jsonl`), mode: "new" };
}

function extractText(msg: { content?: Array<{ type?: string; text?: string }> }): string {
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((b) => b?.type === "text")
		.map((b) => b.text ?? "")
		.join("\n")
		.trim();
}

/**
 * Pulls the final assistant text out of a free-code NDJSON event stream.
 * Prefers the last assistant message carried by the `agent_end` event (the
 * agent loop's final state, post-tool-use); falls back to the last
 * `message_end` of role assistant if no `agent_end` was emitted.
 */
export function extractResult(stdout: string): string {
	let result = "";
	let sawAgentEnd = false;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: Record<string, unknown>;
		try {
			evt = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (evt.type === "agent_end" && Array.isArray(evt.messages)) {
			sawAgentEnd = true;
			const lastAssistant = [...(evt.messages as unknown[])].reverse().find(
				(m) => typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant",
			) as { content?: Array<{ type?: string; text?: string }> } | undefined;
			if (lastAssistant) result = extractText(lastAssistant);
		} else if (evt.type === "message_end" && !sawAgentEnd) {
			const msg = evt.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
			if (msg?.role === "assistant") result = extractText(msg);
		}
	}
	return result;
}

/**
 * Reshapes free-code's NDJSON stdout into the `{result, session_id}` envelope
 * `dispatch.callbackPayload` lifts `result`/`session_id` from — so the hub
 * sees the same payload shape regardless of which adapter ran the job. The
 * envelope is never an empty string, so dispatch's `if (!run.stdout)` guard
 * always lets `session_id` through (letting the caller continue the chain
 * even when the run produced no final text).
 */
export function buildEnvelope(stdout: string, sessionFile: string): string {
	return JSON.stringify({ result: extractResult(stdout), session_id: sessionFile });
}

export function runFreeCode(hook: HookConfig, event: WebhookEvent): Promise<RunResult> {
	const prompt = renderPrompt(hook, event);
	const { file: sessionFile, mode } = sessionPath(event.hook, event.headers.sessionid);
	// `text` in visible mode so the terminal shows a readable transcript
	// instead of a raw NDJSON blob (the runVisible pause is what makes it
	// readable before the window closes). Hidden runs use `json` so we can
	// parse the result back out of stdout.
	const outputMode = hook.visible ? "text" : "json";
	const args = [
		"-p",
		prompt,
		"--mode",
		outputMode,
		"--session",
		sessionFile,
		...toolsArgs(hook.permissionMode),
		// The sandbox workdir isn't a real repo and its contents are untrusted
		// job input — don't let free-code discover skills/extensions/themes or
		// auto-start the RAG server from it.
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-rag-server",
	];

	const cwd = hook.workdir ?? process.cwd();
	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${event.hook}-${Date.now()}.log`);

	if (hook.visible) return runVisible(args, BINARY, cwd, mode, logFile);

	// Hidden mode: Node owns the log file directly, so the header is written
	// here up front (there's no terminal shell to print its own).
	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	logStream.write(`$ ${BINARY} ${args.map((a) => (a === prompt ? JSON.stringify(a) : a)).join(" ")}\ncwd: ${cwd}\n\n`);
	return runHidden(args, BINARY, cwd, mode, logFile, logStream).then((result) => {
		// Turn the NDJSON stream into the {result, session_id} envelope. If the
		// spawn itself failed (no stdout at all), leave stdout unset so the
		// callback falls back to {ok:false, exitCode, mode} exactly like claude.
		if (result.stdout !== undefined) {
			result.stdout = buildEnvelope(resolveStdoutForExtract(result.stdout, logFile), sessionFile);
		}
		return result;
	});
}

/**
 * Returns the stdout to feed into `extractResult`. free-code's json stream can
 * be large (each message_update carries the full partial message, so the
 * output grows quadratically with turn length), and `runHidden` caps the
 * in-memory capture at MAX_STDOUT_CAPTURE. The final agent_end — which
 * carries the text we extract — sits at the very end of the stream, so a big
 * run can lose it to truncation. The log file holds the full stream
 * (runHidden pipes stdout to it independently of the capture), so when the
 * captured stdout lacks an agent_end, fall back to the tail of the log file.
 */
export function resolveStdoutForExtract(stdout: string, logFile: string): string {
	if (stdout.includes('"type":"agent_end"')) return stdout;
	try {
		return readLogTail(logFile, 1024 * 1024);
	} catch {
		return stdout;
	}
}

/**
 * Reads the last `bytes` of `file` as UTF-8. `extractResult` already skips a
 * partial first line, so starting mid-line is fine.
 */
function readLogTail(file: string, bytes: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}
