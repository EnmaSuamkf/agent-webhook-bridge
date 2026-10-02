/** hooks.json can now carry `sandbox.env` `NAME=value` secrets: saveConfig must write it owner-only. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awb-config-test-"));
process.env.AWB_HOME = path.join(tmp, "bridge");
const { loadConfig, saveConfig } = await import("./config.ts");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SECRET = "gho_dummyDummyDummyDummyDummyDummy1234";

function withHook() {
	const cfg = loadConfig();
	cfg.hooks.demo = { mode: "spawn", consumers: ["claude"], sandbox: { kind: "docker", image: "img", env: [`COPILOT_GITHUB_TOKEN=${SECRET}`, "PLAIN"] } } as never;
	return cfg;
}

test("saveConfig creates hooks.json with mode 600", () => {
	saveConfig(withHook());
	assert.equal(fs.statSync(path.join(tmp, "bridge", "hooks.json")).mode & 0o777, 0o600);
});

test("saveConfig tightens a pre-existing world-readable hooks.json", () => {
	const file = path.join(tmp, "bridge", "hooks.json");
	fs.chmodSync(file, 0o644);
	saveConfig(withHook());
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("`awb list` / `awb add` print env names only, never values", () => {
	saveConfig(withHook());
	const cli = path.join(import.meta.dirname, "..", "cli", "awb.ts");
	const out = spawnSync(process.execPath, [cli, "list"], { env: { ...process.env, AWB_HOME: path.join(tmp, "bridge") }, encoding: "utf8" });
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.includes("COPILOT_GITHUB_TOKEN, PLAIN"), out.stdout);
	assert.ok(!out.stdout.includes(SECRET) && !out.stderr.includes(SECRET));
});
