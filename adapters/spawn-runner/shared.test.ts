/**
 * Tests for the env plumbing in adapters/spawn-runner/shared.ts: a
 * `sandbox.env` `NAME=value` entry must reach the docker CLI's ENVIRONMENT and
 * nowhere else — not argv (`ps`), not the run log header.
 *
 * A fake `docker` placed first on PATH stands in for the real one: it prints
 * its own argv and the length + sha256 of `$COPILOT_GITHUB_TOKEN` (never the
 * value), which is all the assertions need.
 */
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { HookConfig } from "../../broker/config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awb-shared-test-"));
process.env.AWB_HOME = path.join(tmp, "bridge");
process.env.HOME = tmp;
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
	path.join(bin, "docker"),
	`#!/bin/sh
echo "ARGV: $@"
echo "TOKEN_LEN: \${#COPILOT_GITHUB_TOKEN}"
echo "TOKEN_SHA: $(printf %s "$COPILOT_GITHUB_TOKEN" | sha256sum | cut -d' ' -f1)"
`,
	{ mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { wrapForSandbox } = await import("./sandbox.ts");
const { commandHeader, runHidden } = await import("./shared.ts");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOKEN = "gho_dummyDummyDummyDummyDummyDummy1234";
const hook = { mode: "spawn", consumers: [], workdir: tmp, sandbox: { kind: "docker", image: "img", env: [`COPILOT_GITHUB_TOKEN=${TOKEN}`] } } as unknown as HookConfig;

test("runHidden: the child sees NAME from extraEnv while argv carries no value", async () => {
	const run = wrapForSandbox("copilot", ["-p", "hi"], hook);
	assert.deepEqual(run.env, { COPILOT_GITHUB_TOKEN: TOKEN });
	const logFile = path.join(tmp, "run.log");
	const logStream = fs.createWriteStream(logFile);
	logStream.write(`${commandHeader(run.binary, run.args)}\n`);
	const result = await runHidden(run.args, run.binary, tmp, "new", logFile, logStream, undefined, undefined, run.env);
	assert.equal(result.ok, true);
	const out = result.stdout as string;
	assert.match(out, new RegExp(`TOKEN_LEN: ${TOKEN.length}\\b`));
	assert.match(out, new RegExp(`TOKEN_SHA: ${crypto.createHash("sha256").update(TOKEN).digest("hex")}`));
	// `ps`-style inspection: the argv the fake docker saw (and printed).
	const argvLine = out.split("\n").find((l) => l.startsWith("ARGV:")) as string;
	assert.ok(argvLine.includes("-e COPILOT_GITHUB_TOKEN"));
	assert.ok(!argvLine.includes(TOKEN));
	assert.ok(!out.includes(TOKEN));
	// the log (header + captured output) never holds the value either
	assert.ok(!fs.readFileSync(logFile, "utf8").includes(TOKEN));
});

test("runHidden without extraEnv leaves the variable unset", async () => {
	delete process.env.COPILOT_GITHUB_TOKEN;
	const logFile = path.join(tmp, "run2.log");
	const result = await runHidden(["x"], "docker", tmp, "new", logFile, fs.createWriteStream(logFile));
	assert.match(result.stdout as string, /TOKEN_LEN: 0\b/);
});

test("commandHeader redacts a long NAME=value after -e, keeps short ones and plain names", () => {
	const header = commandHeader("docker", ["run", "-e", "HOME=/home/u", "-e", "COPILOT_GITHUB_TOKEN", "-e", `LEAK=${TOKEN}`, "img"]);
	assert.equal(header, "$ docker run -e HOME=/home/u -e COPILOT_GITHUB_TOKEN -e LEAK=*** img");
	assert.ok(!header.includes(TOKEN));
});

test("commandHeader applies the display transform to non-env args", () => {
	assert.equal(commandHeader("b", ["a", "p"], (x) => (x === "p" ? '"p"' : x)), '$ b a "p"');
});
