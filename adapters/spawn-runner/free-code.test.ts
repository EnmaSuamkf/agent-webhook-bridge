/**
 * Tests for the free-code adapter's flag construction
 * (adapters/spawn-runner/free-code.ts).
 *
 * What's pinned here is the pair of properties that define what a spawned
 * run can do:
 *
 *  - the run loads free-code's full environment: extensions (subagent
 *    widget included — drop discovery and nothing errors, the agent just
 *    answers "I have no tool to delegate with"), skills, prompt templates
 *    and themes are auto-discovered exactly like a hand-run free-code in
 *    that directory. The single exclusion is `--no-rag-server`: the sandbox
 *    image has no RAG server and its auto-start otherwise blocks startup
 *    for ~90s;
 *  - `permissionMode` still grades the *built-in* tools. Extension-spawned
 *    subagents inherit the parent's active built-ins, so a read-only mode
 *    that grew a `write` here would silently become a read-only mode that
 *    can write through a subagent.
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

const { spawnArgs, toolsArgs } = await import("./free-code.ts");

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("spawnArgs loads the full environment — no --no-extensions, no explicit -e", () => {
	const args = spawnArgs("do the thing", "json", "/s/x.jsonl", undefined);

	// The subagent widget and every other extension are auto-discovered from
	// `~/.free-code/agent/extensions/` (mounted at its own path in the docker
	// sandbox), so neither a discovery blocker nor an explicit `-e` may appear.
	assert.ok(!args.includes("--no-extensions"), "spawned runs must discover extensions");
	assert.ok(!args.includes("-e"), "no explicit -e: discovery already loads the subagent widget");
	assert.ok(!args.includes("--no-skills"));
	assert.ok(!args.includes("--no-prompt-templates"));
	assert.ok(!args.includes("--no-themes"));

	// Core invocation shape: prompt, output mode and session file.
	assert.deepEqual(args.slice(0, 6), ["-p", "do the thing", "--mode", "json", "--session", "/s/x.jsonl"]);
});

test("spawnArgs keeps --no-rag-server as the single discovery exclusion", () => {
	for (const mode of [undefined, "acceptEdits", "bypassPermissions"] as const) {
		const args = spawnArgs("p", "json", "/s/x.jsonl", mode);
		assert.ok(args.includes("--no-rag-server"), `mode ${mode} must keep --no-rag-server`);
	}
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
