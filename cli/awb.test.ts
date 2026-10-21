/** `awb add --model` round-trip: the id lands in hooks.json; missing/empty leaves the key out. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awb-cli-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const awb = path.join(import.meta.dirname, "awb.ts");

function add(...args: string[]) {
	const r = spawnSync(process.execPath, [awb, "add", ...args], {
		env: { ...process.env, AWB_HOME: tmp },
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(fs.readFileSync(path.join(tmp, "hooks.json"), "utf8")).hooks;
}

test("awb add --model writes model to hooks.json", () => {
	assert.equal(add("with-model", "--model", "claude-opus-4-5")["with-model"].model, "claude-opus-4-5");
});

test("awb add without --model omits the key", () => {
	assert.equal("model" in add("no-model")["no-model"], false);
});

test("awb add --model '' is treated as unset", () => {
	assert.equal("model" in add("empty-model", "--model", "")["empty-model"], false);
	assert.equal("model" in add("blank-model", "--model", "  ")["blank-model"], false);
});
