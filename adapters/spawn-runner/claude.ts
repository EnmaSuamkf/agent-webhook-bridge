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
}

function renderPrompt(hook: HookConfig, event: WebhookEvent): string {
	const payload = typeof event.body === "string" ? event.body : JSON.stringify(event.body, null, 2);
	const template = hook.promptTemplate ?? "Incoming webhook event for '{{hook}}':\n\n{{payload}}";
	return template.replaceAll("{{payload}}", payload).replaceAll("{{hook}}", event.hook);
}

export function runClaude(hook: HookConfig, event: WebhookEvent): Promise<ClaudeRunResult> {
	const prompt = renderPrompt(hook, event);
	const sessionId = event.headers.sessionid;
	const mode: "resume" | "new" = sessionId ? "resume" : "new";
	// `--resume` alone opens the interactive picker (no TTY in a spawned
	// child => hangs). `-p`/`--print` is required to make it headless too.
	const args = sessionId
		? ["--resume", sessionId, "-p", prompt, "--output-format", "json"]
		: ["-p", prompt, "--output-format", "json"];
	// Headless runs have no TTY to answer a permission prompt, so any
	// Write/Edit/Bash the model attempts is auto-denied unless the hook opts
	// into a permission mode explicitly.
	if (hook.permissionMode) args.push("--permission-mode", hook.permissionMode);

	const cwd = hook.workdir ?? process.cwd();
	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${event.hook}-${Date.now()}.log`);
	const logStream = fs.createWriteStream(logFile, { flags: "a" });
	logStream.write(`$ claude ${args.map((a) => (a === prompt ? JSON.stringify(a) : a)).join(" ")}\ncwd: ${cwd}\n\n`);

	return new Promise((resolve) => {
		const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.pipe(logStream, { end: false });
		child.stderr.pipe(logStream, { end: false });
		child.on("close", (exitCode) => {
			logStream.end();
			resolve({ ok: exitCode === 0, mode, exitCode, logFile });
		});
		child.on("error", (err) => {
			logStream.write(`\nspawn error: ${String(err)}\n`);
			logStream.end();
			resolve({ ok: false, mode, exitCode: null, logFile });
		});
	});
}
