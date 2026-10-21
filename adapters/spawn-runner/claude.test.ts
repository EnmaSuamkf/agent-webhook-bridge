/** Tests for the Claude adapter's argv (adapters/spawn-runner/claude.ts). */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "awb-claude-test-"));
process.env.AWB_HOME = path.join(tmpHome, "bridge");
const { spawnArgs } = await import("./claude.ts");

test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

test("spawnArgs keeps the new and resume shapes with permission mode", () => {
	assert.deepEqual(spawnArgs("hi", "json", undefined, undefined), ["-p", "hi", "--output-format", "json"]);
	assert.deepEqual(spawnArgs("hi", "text", "sid-1", "acceptEdits"), [
		"--resume", "sid-1", "-p", "hi", "--output-format", "text", "--permission-mode", "acceptEdits",
	]);
});

test("spawnArgs passes --model as two argv items on new and resumed runs", () => {
	assert.deepEqual(spawnArgs("hi", "json", undefined, "plan", "claude-opus-4-5"), [
		"-p", "hi", "--output-format", "json", "--permission-mode", "plan", "--model", "claude-opus-4-5",
	]);
	assert.deepEqual(spawnArgs("hi", "json", "sid-1", undefined, "claude-opus-4-5"), [
		"--resume", "sid-1", "-p", "hi", "--output-format", "json", "--model", "claude-opus-4-5",
	]);
});

test("spawnArgs omits --model when unset or empty", () => {
	for (const sid of [undefined, "sid-1"]) {
		for (const m of [undefined, ""]) assert.equal(spawnArgs("hi", "json", sid, "plan", m).includes("--model"), false);
	}
});
