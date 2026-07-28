/**
 * Tests for the optional docker sandbox (adapters/spawn-runner/sandbox.ts).
 *
 * Two things are pinned here, because both fail *silently* when they break:
 *
 *  - a hook WITHOUT a `sandbox` block must come back byte-identical, so every
 *    hooks.json written before this feature keeps spawning exactly as it did;
 *  - a docker hook must mount the workdir at its own absolute path and `-w`
 *    that same path. A mismatch there doesn't error — it just files the
 *    harness's transcripts under a slug nobody watches, and every run looks
 *    stalled to the caller ten minutes later.
 *
 * `AWB_HOME` and `HOME` are pointed at a throwaway dir so the mounts derived
 * from the operator's real home don't leak into the assertions.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { HookConfig } from "../../broker/config.ts";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "awb-sandbox-test-"));
process.env.AWB_HOME = path.join(tmpHome, "bridge");
// os.homedir() reads $HOME on POSIX, which is what the harness-state mounts
// are derived from; set it before the module under test is imported.
process.env.HOME = tmpHome;
assert.equal(os.homedir(), tmpHome);

const { dockerRunArgs, harnessStateMounts, hostUser, wrapForSandbox } = await import("./sandbox.ts");
const { SANDBOX_LIMITS } = await import("../../broker/config.ts");

test.after(() => {
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

const WORKDIR = "/home/u/repos/demo";

/** A minimal hook. `unknown` in the middle so the "unknown sandbox kind" case can be expressed at all. */
function hook(extra: Record<string, unknown> = {}): HookConfig {
	return { mode: "trigger", consumers: ["spawn:claude"], workdir: WORKDIR, ...extra } as unknown as HookConfig;
}

test("a hook without a sandbox block spawns exactly as before (same binary, same argv object)", () => {
	const args = ["--resume", "sess-1", "-p", "do the thing", "--output-format", "json"];
	const run = wrapForSandbox("claude", args, hook());
	assert.equal(run.binary, "claude");
	assert.deepEqual(run.args, args);
	// Not merely equal: the adapter's own array, untouched.
	assert.equal(run.args, args);
});

test("a sandbox of an unknown kind is ignored rather than guessed at", () => {
	const args = ["-p", "hi"];
	const run = wrapForSandbox("claude", args, hook({ sandbox: { kind: "podman", image: "x" } }));
	assert.equal(run.binary, "claude");
	assert.deepEqual(run.args, args);
});

test("a docker hook produces the exact docker run argv, with the agent argv appended verbatim", () => {
	// Only the workdir is mountable here: no ~/.claude, no ~/.claude.json and
	// no sessions dir exist under the throwaway home, so harnessStateMounts()
	// is empty and the expected argv stays exact.
	assert.deepEqual(harnessStateMounts(), []);
	const agentArgs = ["--resume", "sess-1", "-p", "say hello", "--output-format", "json"];
	const run = wrapForSandbox("claude", agentArgs, hook({ sandbox: { kind: "docker", image: "target-agent:latest" } }));

	assert.equal(run.binary, "docker");
	assert.deepEqual(run.args, [
		"run",
		"--rm",
		"--init",
		"--user",
		hostUser(),
		"--memory",
		SANDBOX_LIMITS.memory,
		"--cpus",
		SANDBOX_LIMITS.cpus,
		"--pids-limit",
		String(SANDBOX_LIMITS.pidsLimit),
		"-v",
		`${WORKDIR}:${WORKDIR}`,
		"-e",
		`HOME=${tmpHome}`,
		"-w",
		WORKDIR,
		"target-agent:latest",
		"claude",
		...agentArgs,
	]);
});

test("the workdir is mounted at its own path and is also the working directory", () => {
	const run = wrapForSandbox("claude", ["-p", "hi"], hook({ sandbox: { kind: "docker", image: "img" } }));
	const mounts = run.args.filter((a, i) => run.args[i - 1] === "-v");
	assert.ok(mounts.includes(`${WORKDIR}:${WORKDIR}`), "workdir must be bind-mounted at its own absolute path");
	// -w is the same string as the host workdir: that identity is what lets the
	// caller find the transcripts the harness writes.
	assert.equal(run.args[run.args.indexOf("-w") + 1], WORKDIR);
	for (const mount of mounts) {
		const [host, container] = mount.split(":");
		assert.equal(host, container, `mount ${mount} is not identity-mapped`);
	}
});

test("the container runs as the broker's uid:gid so repo files stay owned by the operator", () => {
	const run = wrapForSandbox("claude", ["-p", "hi"], hook({ sandbox: { kind: "docker", image: "img" } }));
	assert.equal(run.args[run.args.indexOf("--user") + 1], `${process.getuid?.()}:${process.getgid?.()}`);
});

test("user, resource limits, extra mounts and env are taken from the hook", () => {
	const run = wrapForSandbox(
		"claude",
		["-p", "hi"],
		hook({
			sandbox: {
				kind: "docker",
				image: "img",
				user: "0:0",
				memory: "1g",
				cpus: "0.5",
				pidsLimit: 64,
				mounts: ["/opt/toolchain"],
				env: ["ANTHROPIC_API_KEY", "AWB_TAG=demo"],
			},
		}),
	);
	assert.equal(run.args[run.args.indexOf("--user") + 1], "0:0");
	assert.equal(run.args[run.args.indexOf("--memory") + 1], "1g");
	assert.equal(run.args[run.args.indexOf("--cpus") + 1], "0.5");
	assert.equal(run.args[run.args.indexOf("--pids-limit") + 1], "64");
	assert.ok(run.args.includes("/opt/toolchain:/opt/toolchain"));
	assert.ok(run.args.includes("ANTHROPIC_API_KEY"));
	assert.ok(run.args.includes("AWB_TAG=demo"));
});

test("harnessStateMounts picks up the harness home and the sessions dir once they exist, and skips what doesn't", () => {
	fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(tmpHome, "bridge", "sessions"), { recursive: true });
	assert.deepEqual(harnessStateMounts(), [path.join(tmpHome, ".claude"), path.join(tmpHome, "bridge", "sessions")]);
	// ~/.claude.json doesn't exist → not mounted (a bind mount of a missing
	// source makes docker invent a root-owned directory in its place).
	assert.ok(!harnessStateMounts().includes(path.join(tmpHome, ".claude.json")));

	fs.writeFileSync(path.join(tmpHome, ".claude.json"), "{}\n");
	assert.deepEqual(harnessStateMounts(), [
		path.join(tmpHome, ".claude"),
		path.join(tmpHome, ".claude.json"),
		path.join(tmpHome, "bridge", "sessions"),
	]);

	// …and they reach the argv, identity-mapped like the workdir.
	const run = wrapForSandbox("claude", ["-p", "hi"], hook({ sandbox: { kind: "docker", image: "img" } }));
	for (const mount of harnessStateMounts()) assert.ok(run.args.includes(`${mount}:${mount}`), `${mount} not mounted`);

	fs.rmSync(path.join(tmpHome, ".claude"), { recursive: true, force: true });
	fs.rmSync(path.join(tmpHome, ".claude.json"), { force: true });
	fs.rmSync(path.join(tmpHome, "bridge", "sessions"), { recursive: true, force: true });
});

test("a relative workdir is resolved to an absolute path before it becomes a mount", () => {
	const run = wrapForSandbox("claude", ["-p", "hi"], hook({ workdir: "sub/dir", sandbox: { kind: "docker", image: "img" } }));
	const expected = path.resolve("sub/dir");
	assert.ok(run.args.includes(`${expected}:${expected}`));
	assert.equal(run.args[run.args.indexOf("-w") + 1], expected);
});

test("dockerRunArgs ends at the image and accepts extra flags (e.g. -it for an interactive resume)", () => {
	const args = dockerRunArgs({ kind: "docker", image: "img" }, WORKDIR, ["-it"]);
	assert.equal(args.at(-1), "img");
	assert.ok(args.includes("-it"));
});
