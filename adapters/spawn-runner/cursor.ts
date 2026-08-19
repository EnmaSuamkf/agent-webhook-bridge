/**
 * Spawn adapter for Cursor Agent CLI (`agent`).
 *
 * Same shape as the claude adapter: hidden/visible run, log file, result
 * callback. Cursor resumes by chat uuid (`--resume <id>`) like claude, but
 * headless runs also need `--trust` (no TTY to confirm workspace trust) and
 * `--workspace <cwd>` (sessions are scoped to the workspace they started in).
 *
 * Output: `--output-format json` emits one JSON object on success with
 * `result` and `session_id`. The adapter reshapes it into the
 * `{result, session_id}` envelope `dispatch.callbackPayload` already expects
 * from claude — the broker/hub side stays uniform.
 *
 * Permissions: Cursor has no `--permission-mode`. In headless (`-p`) runs there
 * is no TTY to answer prompts, so every spawn always passes:
 *
 *   --trust         — skip the "trust this workspace?" prompt
 *   --approve-mcps  — auto-approve MCP servers (without it, MCP can hang or
 *                     error in CI/headless; see Cursor forum + docs)
 *
 * File edits and shell commands additionally need `--force` (or `--yolo`) to
 * apply changes instead of only proposing them (headless docs). The hook's
 * `permissionMode` maps to that flag:
 *   unset, manual, plan → no --force (read/analyse only; edits proposed, not applied)
 *   acceptEdits, auto, dontAsk, bypassPermissions → --force
 *
 * MCP warm-up: on a NEW session only, before the real `agent -p` run (and
 * therefore before `runHidden` fires the broker's `started` callback), this
 * adapter runs `agent mcp list` so MCP child processes get time to connect.
 * The Target hub step stays `queued` during warm-up; `started` only arrives
 * when the real run acquires the workdir flock. Resumed sessions skip it —
 * MCPs are already warm in that chat. Disable with `CURSOR_MCP_WARMUP_MS=0`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logsDir, type HookConfig, type PermissionMode } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";
import { wrapForSandbox } from "./sandbox.ts";
import { renderPrompt, runHidden, runVisible, type RunResult, type SpawnHook, type StartedHook } from "./shared.ts";

const BINARY = "agent";

/** Default ceiling for `agent mcp list` warm-up on a new session. */
export const DEFAULT_MCP_WARMUP_MS = 60_000;

/** Flags every headless spawn needs so nothing blocks on a missing TTY. */
export function headlessTrustArgs(): string[] {
	return ["--trust", "--approve-mcps"];
}

/** Maps the hook's claude-style `permissionMode` to Cursor `--force`. */
export function forceArgs(permissionMode: PermissionMode | undefined): string[] {
	switch (permissionMode) {
		case undefined:
		case "manual":
		case "plan":
			return [];
		case "acceptEdits":
		case "bypassPermissions":
		case "auto":
		case "dontAsk":
			return ["--force"];
	}
}

/** argv for the MCP warm-up subprocess (`agent mcp list …`). */
export function warmupArgs(workdir: string): string[] {
	return ["mcp", "list", ...headlessTrustArgs(), "--workspace", workdir];
}

/** How long warm-up may run. `CURSOR_MCP_WARMUP_MS=0` disables it. */
export function warmupTimeoutMs(): number {
	const raw = process.env.CURSOR_MCP_WARMUP_MS;
	if (raw === "0" || raw === "false") return 0;
	if (!raw) return DEFAULT_MCP_WARMUP_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MCP_WARMUP_MS;
}

// Test seam — same pattern as target hub's awb `_impl.spawnSync`.
export const _impl = { spawn };

/**
 * Runs `agent mcp list` before the first turn of a new session so MCP servers
 * can finish connecting. Best-effort: a non-zero exit or a timeout still lets
 * the real run proceed — the warm-up only buys time, it is not a gate.
 */
export function warmupMcps(hook: HookConfig, workdir: string, logStream: fs.WriteStream): Promise<void> {
	const timeoutMs = warmupTimeoutMs();
	if (timeoutMs === 0) return Promise.resolve();

	const run = wrapForSandbox(BINARY, warmupArgs(workdir), hook);
	logStream.write(`# MCP warm-up (new session, step stays queued until the real run starts)\n`);
	logStream.write(`$ ${run.binary} ${run.args.join(" ")}\ncwd: ${workdir}\n\n`);

	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = _impl.spawn(run.binary, run.args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			logStream.write("\n# MCP warm-up: spawn failed — continuing with the real run\n\n");
			resolve();
			return;
		}
		let settled = false;
		const finish = (note: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			logStream.write(`\n# MCP warm-up: ${note}\n\n`);
			resolve();
		};
		const timer = setTimeout(() => finish(`timed out after ${timeoutMs}ms — continuing`), timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => logStream.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => logStream.write(chunk));
		child.on("close", (code) => finish(`finished (exit ${code ?? "null"})`));
		child.on("error", (err) => finish(`spawn error (${String(err)})`));
	});
}

/**
 * The argv `runCursor` spawns `agent` with (after the binary). Extracted so
 * tests can pin the flag list directly.
 */
export function spawnArgs(
	prompt: string,
	outputFormat: "text" | "json",
	workdir: string,
	sessionId: string | undefined,
	permissionMode: PermissionMode | undefined,
): string[] {
	const args = [
		"-p",
		prompt,
		"--output-format",
		outputFormat,
		...headlessTrustArgs(),
		"--workspace",
		workdir,
		...forceArgs(permissionMode),
	];
	if (sessionId) args.push("--resume", sessionId);
	return args;
}

/** Reshapes Cursor's JSON stdout into the callback envelope. */
export function buildEnvelope(stdout: string): string {
	const parsed = JSON.parse(stdout) as Record<string, unknown>;
	const result = typeof parsed.result === "string" ? parsed.result : "";
	const session_id = typeof parsed.session_id === "string" ? parsed.session_id : "";
	return JSON.stringify({ result, session_id });
}

export async function runCursor(
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
	const args = spawnArgs(prompt, outputFormat, cwd, sessionId, hook.permissionMode);

	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${event.hook}-${Date.now()}.log`);

	const run = wrapForSandbox(BINARY, args, hook);

	if (hook.visible) return runVisible(run.args, run.binary, cwd, mode, logFile, onSpawn, onStarted);

	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	// Warm-up runs before `runHidden`, which is what fires `onStarted` — so the
	// hub step stays `queued` until MCPs have had a chance to connect.
	if (mode === "new") await warmupMcps(hook, cwd, logStream);

	logStream.write(`$ ${run.binary} ${run.args.map((a) => (a === prompt ? JSON.stringify(a) : a)).join(" ")}\ncwd: ${cwd}\n\n`);
	return runHidden(run.args, run.binary, cwd, mode, logFile, logStream, onSpawn, onStarted).then((result) => {
		if (result.stdout !== undefined) {
			try {
				result.stdout = buildEnvelope(result.stdout);
			} catch {
				// Leave stdout as-is; callback falls back to ok/exitCode.
			}
		}
		return result;
	});
}
