/**
 * Tests for `killRun` (broker/db.ts): the abort escalation must report `killed`
 * only once the process group is verified gone. Uses a throwaway AWB_HOME so
 * the operator's live broker state is never touched, and real `sleep` process
 * groups (detached => group leader, like the spawn adapters' children).
 */
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "awb-kill-test-"));
process.env.AWB_HOME = home;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const { findRun, killRun, pidAlive, registerRun, unregisterRun } = await import("./db.ts");

test("killRun on a live `sleep 60` group: killed, SIGINT, verified gone, row reaped", async () => {
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const pid = child.pid as number;
	registerRun("h", "job-live", pid);
	const outcome = await killRun("h", "job-live");
	await exited;
	assert.equal(outcome.result, "killed");
	assert.equal(outcome.exited, true);
	assert.ok(outcome.signal === "SIGINT" || outcome.signal === "SIGTERM");
	assert.equal(pidAlive(pid), false);
	assert.equal((await killRun("h", "job-live")).result, "not_running");
});

test("killRun with no run registered: not_running, nothing signalled", async () => {
	assert.deepEqual(await killRun("h", "nope"), { result: "not_running", signal: null, exited: false });
});

test("(f) a group that survives every signal: kill_failed, exited:false, row kept, full escalation tried", async () => {
	// Fake syscalls + clock: the group "never dies", and we don't wait out ~7s.
	let t = 0;
	const sent: Array<[number, string | number]> = [];
	const ops = {
		kill: (pid: number, signal: NodeJS.Signals | 0) => {
			sent.push([pid, signal]);
		},
		wait: async (ms: number) => {
			t += ms;
		},
		now: () => t,
	};
	registerRun("h", "job-stuck", process.pid); // a live pid so findRun doesn't reap the row
	const outcome = await killRun("h", "job-stuck", ops);
	assert.deepEqual(outcome, { result: "kill_failed", signal: "SIGKILL", exited: false });
	const signals = sent.map(([, s]) => s).filter((s) => s !== 0);
	assert.deepEqual(signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
	assert.ok(sent.every(([pid]) => pid === -process.pid), "always the whole group, never the bare pid");
	assert.ok(t <= 7500, `worst-case wait stays under budget (${t}ms)`);
	// Row kept, so a retry can still reach it.
	assert.equal(findRun("h", "job-stuck")?.pid, process.pid);
	unregisterRun("h", "job-stuck");
});

test("(f) the group vanishing between signals is reported killed with the signal that preceded it", async () => {
	let alive = true;
	const ops = {
		kill: (_pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGTERM") alive = false; // only SIGTERM "works"
			if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		},
		wait: async () => {},
		now: (() => {
			let n = 0;
			return () => (n += 50);
		})(),
	};
	registerRun("h", "job-term", process.pid);
	assert.deepEqual(await killRun("h", "job-term", ops), { result: "killed", signal: "SIGTERM", exited: true });
	assert.equal(findRun("h", "job-term"), null);
});
