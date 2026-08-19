/**
 * Tests for the Cursor adapter's flag construction and MCP warm-up
 * (adapters/spawn-runner/cursor.ts).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "awb-cursor-test-"));
process.env.AWB_HOME = path.join(tmpHome, "bridge");
process.env.HOME = tmpHome;

const {
	spawnArgs,
	forceArgs,
	buildEnvelope,
	warmupArgs,
	warmupTimeoutMs,
	warmupMcps,
	DEFAULT_MCP_WARMUP_MS,
	_impl,
} = await import("./cursor.ts");

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.CURSOR_MCP_WARMUP_MS;
});

test("spawnArgs builds a headless new-session invocation with trust, MCP approval, and workspace", () => {
	const args = spawnArgs("do the thing", "json", "/repo", undefined, undefined);
	assert.deepEqual(args, [
		"-p",
		"do the thing",
		"--output-format",
		"json",
		"--trust",
		"--approve-mcps",
		"--workspace",
		"/repo",
	]);
});

test("spawnArgs adds --force when the hook opts into writes or shell", () => {
	const args = spawnArgs("ship it", "json", "/repo", undefined, "acceptEdits");
	assert.ok(args.includes("--force"));
	assert.ok(args.includes("--approve-mcps"));
});

test("spawnArgs resumes when a session id header is present", () => {
	const args = spawnArgs("continue", "json", "/repo", "chat-uuid-1", undefined);
	assert.ok(args.includes("--resume"));
	assert.ok(args.includes("chat-uuid-1"));
});

test("warmupArgs runs agent mcp list with the same trust flags as a headless step", () => {
	assert.deepEqual(warmupArgs("/repo"), ["mcp", "list", "--trust", "--approve-mcps", "--workspace", "/repo"]);
});

test("warmupTimeoutMs defaults to 60s and respects CURSOR_MCP_WARMUP_MS", () => {
	delete process.env.CURSOR_MCP_WARMUP_MS;
	assert.equal(warmupTimeoutMs(), DEFAULT_MCP_WARMUP_MS);
	process.env.CURSOR_MCP_WARMUP_MS = "15000";
	assert.equal(warmupTimeoutMs(), 15_000);
	process.env.CURSOR_MCP_WARMUP_MS = "0";
	assert.equal(warmupTimeoutMs(), 0);
});

test("forceArgs maps permission modes to --force", () => {
	assert.deepEqual(forceArgs(undefined), []);
	assert.deepEqual(forceArgs("manual"), []);
	assert.deepEqual(forceArgs("plan"), []);
	assert.deepEqual(forceArgs("acceptEdits"), ["--force"]);
	assert.deepEqual(forceArgs("bypassPermissions"), ["--force"]);
});

test("buildEnvelope lifts result and session_id out of Cursor's JSON stdout", () => {
	const stdout = JSON.stringify({
		type: "result",
		subtype: "success",
		result: "done",
		session_id: "sess-abc",
	});
	assert.deepEqual(JSON.parse(buildEnvelope(stdout)), { result: "done", session_id: "sess-abc" });
});

test("warmupMcps is a no-op when CURSOR_MCP_WARMUP_MS=0", async () => {
	process.env.CURSOR_MCP_WARMUP_MS = "0";
	let spawns = 0;
	const original = _impl.spawn;
	_impl.spawn = (() => {
		spawns += 1;
		throw new Error("should not spawn");
	}) as unknown as typeof _impl.spawn;
	try {
		const log = fs.createWriteStream(path.join(tmpHome, "warmup-skip.log"));
		await warmupMcps({ workdir: "/repo" }, "/repo", log);
		await new Promise<void>((resolve) => log.end(resolve));
		assert.equal(spawns, 0);
	} finally {
		_impl.spawn = original;
	}
});

test("warmupMcps resolves early when mcp list exits", async () => {
	process.env.CURSOR_MCP_WARMUP_MS = "60000";
	const original = _impl.spawn;
	_impl.spawn = ((_cmd: string, args: string[]) => {
		assert.deepEqual(args, warmupArgs("/repo"));
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	}) as unknown as typeof _impl.spawn;
	try {
		const logPath = path.join(tmpHome, "warmup-ok.log");
		const log = fs.createWriteStream(logPath);
		const started = Date.now();
		await warmupMcps({ workdir: "/repo" }, "/repo", log);
		await new Promise<void>((resolve) => log.end(resolve));
		assert.ok(Date.now() - started < 2000, "should not wait for the full timeout");
		const text = fs.readFileSync(logPath, "utf8");
		assert.match(text, /MCP warm-up/);
		assert.match(text, /agent mcp list/);
	} finally {
		_impl.spawn = original;
	}
});
