/**
 * Tests for the Copilot adapter (adapters/spawn-runner/copilot.ts): permission
 * mapping, argv, the JSONL -> `{result, session_id}` envelope, and an end-to-end
 * `runCopilot` run against a fake `copilot` script on PATH (no real CLI, no
 * network, no docker).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { HookConfig, PermissionMode } from "../../broker/config.ts";
import type { WebhookEvent } from "../../broker/types.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "awb-copilot-test-"));
process.env.AWB_HOME = path.join(tmpHome, "bridge");
process.env.HOME = tmpHome;

const { permissionArgs, spawnArgs, buildEnvelope, runCopilot } = await import("./copilot.ts");
const { callbackPayload } = await import("../../broker/dispatch.ts");

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SID = "6f1c2f0e-3b7a-4c55-9a39-0d6c1e8b7a42";

const READ_ONLY = ["--available-tools=view,grep,glob", "--deny-tool=write", "--deny-tool=shell"];

test("permissionArgs: unset, manual and plan are read-only", () => {
	for (const mode of [undefined, "manual", "plan"] as Array<PermissionMode | undefined>) {
		assert.deepEqual(permissionArgs(mode), READ_ONLY, String(mode));
	}
});

test("permissionArgs: acceptEdits allows edits but denies the shell", () => {
	assert.deepEqual(permissionArgs("acceptEdits"), ["--allow-tool=write", "--deny-tool=shell"]);
});

test("permissionArgs: auto and dontAsk allow every tool (cwd + /tmp paths)", () => {
	assert.deepEqual(permissionArgs("auto"), ["--allow-all-tools"]);
	assert.deepEqual(permissionArgs("dontAsk"), ["--allow-all-tools"]);
});

test("permissionArgs: bypassPermissions is --allow-all", () => {
	assert.deepEqual(permissionArgs("bypassPermissions"), ["--allow-all"]);
});

test("spawnArgs for a new session carries the common flags and a fresh --session-id uuid", () => {
	const args = spawnArgs("do the thing", "/repo", undefined, undefined, "json");
	assert.equal(args[0], "-p");
	assert.equal(args[1], "do the thing");
	assert.deepEqual(args.slice(2, 4), ["--output-format", "json"]);
	for (const flag of ["--no-auto-update", "--no-color", "--no-ask-user"]) assert.ok(args.includes(flag), flag);
	assert.deepEqual(args.slice(args.indexOf("--stream"), args.indexOf("--stream") + 2), ["--stream", "off"]);
	const sid = args.find((a) => a.startsWith("--session-id="));
	assert.ok(sid, "no --session-id");
	assert.match(sid.slice("--session-id=".length), UUID);
	assert.ok(!args.some((a) => a.startsWith("--resume")));
	// two new sessions never share an id
	const other = spawnArgs("x", "/repo", undefined, undefined, "json").find((a) => a.startsWith("--session-id="));
	assert.notEqual(sid, other);
});

test("spawnArgs for a resume uses --resume=<id> and never --session-id", () => {
	const args = spawnArgs("continue", "/repo", SID, undefined, "json");
	assert.ok(args.includes(`--resume=${SID}`));
	assert.ok(!args.some((a) => a.startsWith("--session-id")));
});

test("spawnArgs passes the permission flags on every call, resumed ones included", () => {
	for (const sid of [undefined, SID]) {
		const args = spawnArgs("p", "/repo", sid, "acceptEdits", "json");
		for (const flag of permissionArgs("acceptEdits")) assert.ok(args.includes(flag), flag);
	}
});

test("spawnArgs uses text output for visible mode", () => {
	const args = spawnArgs("p", "/repo", undefined, undefined, "text");
	assert.deepEqual(args.slice(2, 4), ["--output-format", "text"]);
});

// Real-shaped JSONL, as `copilot -p ... --output-format json --stream off` prints it.
const line = (o: unknown): string => JSON.stringify(o);
const ts = "2026-09-30T12:00:00.000Z";
const mcp = line({ type: "session.mcp_server_status_changed", data: { serverName: "github-mcp-server", status: "connected" }, id: "e1", timestamp: ts, ephemeral: true });
const delta = line({ type: "assistant.reasoning_delta", data: { reasoningId: "r1", deltaContent: "thinking" }, id: "e2", timestamp: ts, ephemeral: true });
const toolMsg = line({
	type: "assistant.message",
	data: { messageId: "m1", model: "claude-haiku-4.5", content: "", toolRequests: [{ toolCallId: "t1", name: "view", arguments: { path: "/repo/a.txt" }, type: "function" }], turnId: "0" },
	id: "e3",
	timestamp: ts,
});
const finalMsg = (content: string): string =>
	line({ type: "assistant.message", data: { messageId: "m2", model: "claude-haiku-4.5", content, toolRequests: [], turnId: "1" }, id: "e4", timestamp: ts });
const resultLine = line({
	type: "result",
	timestamp: ts,
	sessionId: SID,
	exitCode: 0,
	usage: { premiumRequests: 0.33, totalApiDurationMs: 4100, sessionDurationMs: 6200 },
});

test("buildEnvelope takes the last tool-free assistant.message and the result line's sessionId", () => {
	const stdout = [mcp, delta, toolMsg, finalMsg("pong"), resultLine].join("\n") + "\n";
	assert.deepEqual(JSON.parse(buildEnvelope(stdout)), { result: "pong", session_id: SID });
});

test("buildEnvelope: an empty final assistant.message does not erase the earlier answer", () => {
	const stdout = [toolMsg, finalMsg("the answer"), finalMsg(""), resultLine].join("\n");
	assert.deepEqual(JSON.parse(buildEnvelope(stdout)), { result: "the answer", session_id: SID });
});

test("buildEnvelope ignores a tool-calling message even when it carries text", () => {
	const chatty = line({ type: "assistant.message", data: { messageId: "m0", content: "let me look", toolRequests: [{ toolCallId: "t9", name: "grep" }], turnId: "0" } });
	assert.deepEqual(JSON.parse(buildEnvelope([chatty, resultLine].join("\n"))), { result: "", session_id: SID });
});

test("buildEnvelope tolerates blank lines and non-JSON garbage between events", () => {
	const stdout = ["", "Warning: something on stdout", mcp, "   ", "{not json", "42", "null", finalMsg("pong"), "", resultLine, "trailing text"].join("\n");
	assert.deepEqual(JSON.parse(buildEnvelope(stdout)), { result: "pong", session_id: SID });
});

test("buildEnvelope ignores subagent messages (agentId / parentToolCallId)", () => {
	const sub = line({ type: "assistant.message", agentId: "a1", data: { content: "subagent says hi", toolRequests: [], parentToolCallId: "t1" } });
	assert.deepEqual(JSON.parse(buildEnvelope([finalMsg("main answer"), sub, resultLine].join("\n"))), { result: "main answer", session_id: SID });
});

test("buildEnvelope leaves stdout untouched when there is no result line", () => {
	for (const stdout of ["", "Error: No authentication information found.\n", "just text", [mcp, toolMsg, finalMsg("pong")].join("\n")]) {
		assert.equal(buildEnvelope(stdout), stdout);
	}
});

test("dispatch.callbackPayload lifts result/session_id out of the envelope and forwards stderr on failure", () => {
	const ok = callbackPayload({ ok: true, mode: "new", exitCode: 0, logFile: "/l", stdout: buildEnvelope([finalMsg("pong"), resultLine].join("\n")) });
	assert.equal(ok.result, "pong");
	assert.equal(ok.session_id, SID);
	assert.equal(ok.error, undefined);

	const stderr = `No session, task, or name matched '${SID}'\n`;
	const failed = callbackPayload({ ok: false, mode: "resume", exitCode: 1, logFile: "/l", stdout: buildEnvelope(""), stderr });
	assert.equal(failed.ok, false);
	assert.match(String(failed.error), /No session, task, or name matched/);
});

// End to end: a fake `copilot` first on PATH.
const binDir = fs.mkdtempSync(path.join(tmpHome, "bin-"));
const workdir = fs.mkdtempSync(path.join(tmpHome, "work-"));
const fakeCopilot = path.join(binDir, "copilot");
const origPath = process.env.PATH;

function installFake(script: string): void {
	fs.writeFileSync(fakeCopilot, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.PATH = `${binDir}:${origPath}`;
}

function hook(extra: Partial<HookConfig> = {}): HookConfig {
	return { mode: "trigger", consumers: ["spawn:copilot"], workdir, ...extra };
}

function event(headers: Record<string, string> = {}): WebhookEvent {
	return { hook: "cp-test", headers, body: { task: "ping" }, receivedAt: new Date().toISOString() } as unknown as WebhookEvent;
}

test("runCopilot end to end: canned JSONL becomes the envelope and argv carries the flags", async () => {
	const argvFile = path.join(tmpHome, "argv.txt");
	const canned = [mcp, toolMsg, finalMsg("pong"), resultLine].join("\n");
	installFake(`printf '%s\\n' "$@" > '${argvFile}'\ncat <<'EOF'\n${canned}\nEOF\nexit 0`);
	try {
		const res = await runCopilot(hook({ permissionMode: "acceptEdits" }), event());
		assert.equal(res.ok, true);
		assert.equal(res.mode, "new");
		assert.deepEqual(JSON.parse(res.stdout as string), { result: "pong", session_id: SID });
		const argv = fs.readFileSync(argvFile, "utf8").split("\n");
		assert.ok(argv.includes("--output-format") && argv.includes("json"));
		assert.ok(argv.includes("--allow-tool=write") && argv.includes("--deny-tool=shell"));
		assert.ok(argv.some((a) => a.startsWith("--session-id=")));
	} finally {
		process.env.PATH = origPath;
	}
});

test("runCopilot resumes with --resume=<id> when the event has a sessionid header", async () => {
	const argvFile = path.join(tmpHome, "argv2.txt");
	installFake(`printf '%s\\n' "$@" > '${argvFile}'\nexit 0`);
	try {
		const res = await runCopilot(hook(), event({ sessionid: SID }));
		assert.equal(res.mode, "resume");
		const argv = fs.readFileSync(argvFile, "utf8").split("\n");
		assert.ok(argv.includes(`--resume=${SID}`));
		assert.ok(!argv.some((a) => a.startsWith("--session-id")));
	} finally {
		process.env.PATH = origPath;
	}
});

test("runCopilot failure: exit 1 with empty stdout stays a failure and stdout is left untouched", async () => {
	installFake(`echo "No session, task, or name matched '${SID}'" >&2\nexit 1`);
	try {
		const res = await runCopilot(hook(), event({ sessionid: SID }));
		assert.equal(res.ok, false);
		assert.equal(res.exitCode, 1);
		assert.equal(res.stdout, "");
		// The agent's stderr must survive the flock wrapper in shared.ts.
		assert.match(String(callbackPayload(res).error), /No session, task, or name matched/);
	} finally {
		process.env.PATH = origPath;
	}
});
