/**
 * Spawn adapter for GitHub Copilot CLI (`copilot`).
 *
 * Same shape as the cursor adapter: hidden/visible run, log file, result
 * callback, wrapped through `wrapForSandbox`.
 *
 * Output: `--output-format json` prints JSONL, one event per line (stdout only;
 * the same events minus deltas are also written to
 * `~/.copilot/session-state/<uuid>/events.jsonl`). The final answer is NOT in
 * the closing `{"type":"result"}` line (it carries `sessionId`, `exitCode`,
 * `usage`, `premiumRequests`) but in the last main-agent `assistant.message`
 * whose `data.toolRequests` is empty and `data.content` is non-empty. The
 * adapter reshapes the stream into the `{result, session_id}` envelope
 * `dispatch.callbackPayload` already expects from claude/cursor. `--stream off`
 * drops token-level delta events (-40% bytes, same answer).
 *
 * Sessions: the id is a bare uuid. A new run gets an explicit
 * `--session-id=<fresh uuid>`; an event carrying a `sessionid` header resumes
 * with `--resume=<id>` (an unknown id exits 1 with an empty stdout and
 * "No session, task, or name matched ..." on stderr, so a vanished session
 * fails loudly instead of silently starting a new one). Lookup is
 * cwd-independent, but a resumed session keeps running in the cwd it was
 * created in.
 *
 * Permissions: Copilot has no `--permission-mode`; flags are evaluated per
 * invocation and are NOT stored in the session, so the full set is passed on
 * every call, first and resumed. In `-p` runs nothing can answer a prompt: an
 * unapproved tool call is denied at once, never a hang. `--no-ask-user` is
 * always passed so the model cannot block on `ask_user` either. The hook's
 * `permissionMode` maps to (see `permissionArgs`):
 *   unset, manual, plan → read-only (view/grep/glob only, write + shell denied)
 *   acceptEdits         → edits yes, shell no
 *   auto, dontAsk       → all tools, paths limited to cwd + /tmp
 *   bypassPermissions   → everything (tools, any path, any URL)
 *
 * Exit code: Copilot exits 0 even when tool calls were denied (they appear as
 * `tool.execution_complete` with `data.error.code === "denied"`), so exit 0
 * does not prove nothing was blocked.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logsDir, type HookConfig, type PermissionMode } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";
import { wrapForSandbox } from "./sandbox.ts";
import { commandHeader, renderPrompt, runHidden, runVisible, type RunResult, type SpawnHook, type StartedHook } from "./shared.ts";

const BINARY = "copilot";

/**
 * Maps the hook's claude-style `permissionMode` to Copilot tool-permission flags.
 */
export function permissionArgs(permissionMode: PermissionMode | undefined): string[] {
	switch (permissionMode) {
		case undefined:
		case "manual":
		case "plan":
			// Read-only. The tools are removed outright (`--available-tools`) and
			// write/shell are also denied explicitly, so the result does not depend
			// on the default prompting behaviour. `task` is left out on purpose:
			// subagents can recurse and cost premium requests. "manual" has no
			// interactive equivalent in `-p`, so read-only is the honest mapping.
			return ["--available-tools=view,grep,glob", "--deny-tool=write", "--deny-tool=shell"];
		case "acceptEdits":
			// Edits allowed, shell denied (deny wins). `--allow-tool=write` alone is
			// not enough: a shell redirect (`echo > f`) counts as a write and would
			// run. Also blocks read-only shell such as `ls`.
			return ["--allow-tool=write", "--deny-tool=shell"];
		case "auto":
		case "dontAsk":
			// Every tool runs without asking, but file access stays limited to the
			// cwd and the system temp dir (blast radius = the workdir).
			return ["--allow-all-tools"];
		case "bypassPermissions":
			// Tools + any path + any URL. Deliberately the flag, not the env
			// COPILOT_ALLOW_ALL=true (which also trusts the directory).
			return ["--allow-all"];
	}
}

/**
 * The argv `runCopilot` spawns `copilot` with (after the binary). Extracted so
 * tests can pin the flag list directly. `workdir` is the spawn cwd (Copilot
 * has no `--workspace` flag; it runs in the process cwd).
 */
export function spawnArgs(
	prompt: string,
	workdir: string,
	sessionId: string | undefined,
	permissionMode: PermissionMode | undefined,
	outputFormat: "text" | "json",
): string[] {
	void workdir;
	return [
		"-p",
		prompt,
		"--output-format",
		outputFormat,
		"--stream",
		"off",
		"--no-auto-update",
		"--no-color",
		"--no-ask-user",
		sessionId ? `--resume=${sessionId}` : `--session-id=${crypto.randomUUID()}`,
		...permissionArgs(permissionMode),
	];
}

/**
 * Reshapes Copilot's JSONL stdout into the callback envelope. Blank and
 * non-JSON lines are ignored. Without a `result` line (crash, auth failure,
 * unknown --resume id) stdout is returned untouched so the dispatch error path
 * keeps forwarding stderr.
 */
export function buildEnvelope(stdout: string): string {
	let sessionId: string | undefined;
	let result = "";
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let ev: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) continue;
			ev = parsed as Record<string, unknown>;
		} catch {
			continue;
		}
		if (ev.type === "result") {
			if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
		} else if (ev.type === "assistant.message" && ev.agentId === undefined) {
			const data = (ev.data ?? {}) as Record<string, unknown>;
			const requests = data.toolRequests;
			const noTools = !Array.isArray(requests) || requests.length === 0;
			if (noTools && data.parentToolCallId === undefined && typeof data.content === "string" && data.content !== "") {
				result = data.content;
			}
		}
	}
	if (sessionId === undefined) return stdout;
	return JSON.stringify({ result, session_id: sessionId });
}

export async function runCopilot(
	hook: HookConfig,
	event: WebhookEvent,
	onSpawn?: SpawnHook,
	onStarted?: StartedHook,
): Promise<RunResult> {
	const prompt = renderPrompt(hook, event);
	const sessionId = event.headers.sessionid;
	const mode: "resume" | "new" = sessionId ? "resume" : "new";
	const outputFormat = hook.visible ? "text" : "json";
	const cwd = hook.workdir ?? process.cwd();
	const args = spawnArgs(prompt, cwd, sessionId, hook.permissionMode, outputFormat);

	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${event.hook}-${Date.now()}.log`);

	const run = wrapForSandbox(BINARY, args, hook);

	if (hook.visible) return runVisible(run.args, run.binary, cwd, mode, logFile, onSpawn, onStarted, run.env);

	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	logStream.write(`${commandHeader(run.binary, run.args, (a) => (a === prompt ? JSON.stringify(a) : a))}\ncwd: ${cwd}\n\n`);
	return runHidden(run.args, run.binary, cwd, mode, logFile, logStream, onSpawn, onStarted, run.env).then((result) => {
		if (result.stdout !== undefined) result.stdout = buildEnvelope(result.stdout);
		return result;
	});
}
