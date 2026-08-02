/**
 * Tests for the free-code adapter's flag construction
 * (adapters/spawn-runner/free-code.ts).
 *
 * What's pinned here is the pair of properties that make delegation work
 * without handing the untrusted workdir a code-execution hook:
 *
 *  - the subagent tools live in a shipped *extension*, so the run has to load
 *    `subagent-widget.ts` back by absolute `-e` path while `--no-extensions`
 *    keeps discovery off. Drop the `-e` and nothing errors — the agent just
 *    answers "I have no tool to delegate with", which is exactly the bug this
 *    guards;
 *  - `permissionMode` still grades the *built-in* tools. The extension spawns
 *    its child with the parent's active built-ins, so a read-only mode that
 *    grew a `write` here would silently become a read-only mode that can write
 *    through a subagent.
 *
 * `AWB_HOME`/`HOME` point at a throwaway dir so nothing depends on the
 * operator's real home.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "awb-free-code-test-"));
process.env.AWB_HOME = path.join(tmpHome, "bridge");
process.env.HOME = tmpHome;
assert.equal(os.homedir(), tmpHome);

const { subagentExtensionArgs, toolsArgs } = await import("./free-code.ts");

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("subagentExtensionArgs loads the shipped subagent extension by absolute path", () => {
	const dir = path.join(tmpHome, ".free-code", "agent", "extensions");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "subagent-widget.ts");
	fs.writeFileSync(file, "export default function () {}\n");

	assert.deepEqual(subagentExtensionArgs(dir), ["-e", file]);
	// Absolute, because the run may happen inside the docker sandbox, where
	// only a path that resolves identically on both sides can be loaded.
	assert.ok(path.isAbsolute(subagentExtensionArgs(dir)[1]));
});

test("subagentExtensionArgs stays silent when the extension isn't installed", () => {
	// A `-e` pointing at nothing is only a startup diagnostic, but there's no
	// reason to emit one on a host without free-code's global extensions dir.
	assert.deepEqual(subagentExtensionArgs(path.join(tmpHome, "nope")), []);
});

test("the default extensions dir is derived from the home free-code actually uses", () => {
	const dir = path.join(tmpHome, ".free-code", "agent", "extensions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "subagent-widget.ts"), "export default function () {}\n");
	// Called with no argument it must find the same file: sandbox.ts mounts
	// `~/.free-code` at its own absolute path, which is what makes one path
	// valid both on the host and in the container.
	assert.deepEqual(subagentExtensionArgs(), ["-e", path.join(dir, "subagent-widget.ts")]);
});

test("permissionMode still grades the built-in tools (the subagent inherits these)", () => {
	const tools = (mode: Parameters<typeof toolsArgs>[0]) => toolsArgs(mode)[1].split(",");

	for (const mode of [undefined, "manual", "plan"] as const) {
		const t = tools(mode);
		assert.deepEqual(t, ["read", "grep", "find", "ls"]);
		for (const forbidden of ["write", "edit", "bash"]) assert.ok(!t.includes(forbidden), `${mode} must not grant ${forbidden}`);
	}

	assert.deepEqual(tools("acceptEdits"), ["read", "edit", "write", "grep", "find", "ls"]);
	assert.ok(!tools("acceptEdits").includes("bash"));

	for (const mode of ["bypassPermissions", "auto", "dontAsk"] as const) {
		assert.deepEqual(tools(mode), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	}
});
