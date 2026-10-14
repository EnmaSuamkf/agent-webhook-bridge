/**
 * End-to-end tests for the abort protocol: `POST /hook/:name/abort` ->
 * `cancelQueuedJobs` + `killRun` (broker/server.ts, dispatch.ts, db.ts).
 *
 * The real HTTP server and the real dispatch queue run here; only the agent
 * CLI is replaced by a fake runner that spawns a short-lived REAL process
 * (`bash`/`sleep 3601`, detached => its own process group, exactly like the
 * adapters' children) so signals, group kills and "is it really gone" checks
 * are genuine. Everything lives in a throwaway AWB_HOME / workdir on an
 * ephemeral port, so the operator's live broker is never touched, and every
 * test kills whatever it spawned on teardown (`pgrep -f 'sleep 3601'` must be
 * empty afterwards — the marker duration exists for exactly that check).
 */
import * as assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { RunResult } from "../adapters/spawn-runner/shared.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "awb-abort-test-"));
process.env.AWB_HOME = home;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const { createServer } = await import("./server.ts");
const { dispatch, cancelQueuedJobs } = await import("./dispatch.ts");
const { listEvents, pidAlive } = await import("./db.ts");

type Mode = "sleep" | "ignore" | "quick";

const SECRET = "test-secret";
const HOOK = "h";

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

interface Harness {
	post(pathname: string, body: unknown, secret?: string): Promise<{ status: number; json: Record<string, unknown> }>;
	/** Dispatches a job; `tag` names its callback so the test can tell callbacks apart. */
	submit(jobId: string, mode: Mode, tag: string, extra?: Record<string, unknown>): Promise<void>;
	abort(jobId: string): Promise<Record<string, unknown>>;
	/** "<jobId>:<mode>" in the order the fake runner actually spawned them. */
	spawned: string[];
	children: Map<string, ChildProcess>;
	/** Callback tags received, in order. */
	callbacks: string[];
	errorOf(jobId: string): string | null;
	close(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "awb-abort-wd-"));
	const spawned: string[] = [];
	const children = new Map<string, ChildProcess>();
	const callbacks: string[] = [];

	const callbackServer = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			callbacks.push(String(req.url).replace("/cb/", ""));
			res.end("ok");
		});
	});
	await new Promise<void>((r) => callbackServer.listen(0, "127.0.0.1", r));
	const cbPort = (callbackServer.address() as AddressInfo).port;

	const runners = {
		"spawn:claude": {
			tag: "fake",
			run: (_hook: unknown, event: { body: unknown }, onSpawn?: (pid: number) => void, onStarted?: () => void) =>
				new Promise<RunResult>((resolve) => {
					const body = event.body as { jobId: string; mode: Mode; cancelBeforeSpawn?: boolean };
					// Simulates an abort landing after the queue check but before the pid exists.
					if (body.cancelBeforeSpawn) cancelQueuedJobs(HOOK, body.jobId);
					spawned.push(`${body.jobId}:${body.mode}`);
					const script =
						body.mode === "quick"
							? "exit 0"
							: body.mode === "ignore"
								? "trap '' INT TERM; while :; do sleep 3601; done"
								: "exec sleep 3601";
					const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
					children.set(body.jobId, child);
					onSpawn?.(child.pid as number);
					onStarted?.();
					child.on("close", (code) => resolve({ ok: code === 0, mode: "new", exitCode: code, logFile: "/dev/null" }));
				}),
		},
	};

	const server = createServer({
		getConfig: () => ({
			host: "127.0.0.1",
			port: 0,
			maxBodyBytes: 1_000_000,
			publicBaseUrl: null,
			hooks: { [HOOK]: { mode: "trigger", secret: SECRET, consumers: ["spawn:claude"], workdir } },
		}),
		onEvent: (name, hook, event) => dispatch(name, hook, event, () => {}, runners as never),
		log: () => {},
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;

	const h: Harness = {
		spawned,
		children,
		callbacks,
		async post(pathname, body, secret = SECRET) {
			const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-webhook-secret": secret },
				body: JSON.stringify(body),
			});
			return { status: res.status, json: (await res.json()) as Record<string, unknown> };
		},
		async submit(jobId, mode, tag, extra = {}) {
			const res = await h.post(`/hook/${HOOK}`, { jobId, mode, callbackUrl: `http://127.0.0.1:${cbPort}/cb/${tag}`, ...extra });
			assert.equal(res.status, 200);
		},
		async abort(jobId) {
			const res = await h.post(`/hook/${HOOK}/abort`, { jobId });
			assert.equal(res.status, 200);
			return res.json;
		},
		errorOf(jobId) {
			const ev = listEvents(HOOK, 200).find((e) => (e.body as { jobId?: string }).jobId === jobId && e.error === "cancelled");
			return ev ? ev.error : null;
		},
		async close() {
			for (const child of children.values()) {
				try {
					process.kill(-(child.pid as number), "SIGKILL");
				} catch {
					// already gone
				}
			}
			server.closeAllConnections();
			callbackServer.closeAllConnections();
			await Promise.all([
				new Promise((r) => server.close(r)),
				new Promise((r) => callbackServer.close(r)),
			]);
			fs.rmSync(workdir, { recursive: true, force: true });
		},
	};
	return h;
}

test("(a) abort of a queued job behind a running one: cancelled_queued, never spawns, no callback", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("r", "sleep", "r");
	await waitFor(() => h.spawned.length === 1, "r to spawn");
	await h.submit("q", "sleep", "q1");
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(h.spawned, ["r:sleep"], "q must still be queued behind r");

	const res = await h.abort("q");
	assert.deepEqual(res, { result: "cancelled_queued", killed: true, signal: null, exited: false });

	// Let the queue drain: kill r, then q's turn comes and is skipped.
	assert.equal((await h.abort("r")).result, "killed");
	await waitFor(() => h.errorOf("q") === "cancelled", "q to be marked cancelled");
	await waitFor(() => h.callbacks.includes("r"), "r callback");
	assert.deepEqual(h.spawned, ["r:sleep"], "q never spawned");
	assert.ok(!h.callbacks.includes("q1"), "no callback for the cancelled job");
});

test("(b) a later job reusing the aborted jobId still runs (no stale cancel)", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("r", "sleep", "r");
	await waitFor(() => h.spawned.length === 1, "r to spawn");
	await h.submit("q", "sleep", "q1");
	assert.equal((await h.abort("q")).result, "cancelled_queued");
	// Same jobId, dispatched AFTER the abort: fresh entry, must not inherit the cancel.
	await h.submit("q", "quick", "q2");
	assert.equal((await h.abort("r")).result, "killed");

	await waitFor(() => h.callbacks.includes("q2"), "second q to run and call back");
	assert.deepEqual(h.spawned, ["r:sleep", "q:quick"]);
	assert.ok(!h.callbacks.includes("q1"), "the first (cancelled) q posted nothing");
});

test("(c) abort landing between queue check and registerRun: the group is killed right after onSpawn", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("c", "sleep", "c", { cancelBeforeSpawn: true });
	await waitFor(() => h.children.has("c"), "c to spawn");
	const pid = h.children.get("c")?.pid as number;
	await waitFor(() => !pidAlive(pid), "the spawned group to be killed", 6000);
	await waitFor(() => h.errorOf("c") === "cancelled", "c to be marked cancelled");
	assert.ok(!h.callbacks.includes("c"), "a cancelled run posts no callback");
});

test("(d) a cooperative process is stopped by SIGINT and reported killed/SIGINT", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("r", "sleep", "r");
	await waitFor(() => h.children.has("r"), "r to spawn");
	const pid = h.children.get("r")?.pid as number;
	const res = await h.abort("r");
	assert.deepEqual(res, { result: "killed", killed: true, signal: "SIGINT", exited: true });
	assert.equal(pidAlive(pid), false);
});

test("(e) a process ignoring SIGINT and SIGTERM is escalated to SIGKILL", { timeout: 20_000 }, async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("r", "ignore", "r");
	await waitFor(() => h.children.has("r"), "r to spawn");
	await new Promise((r) => setTimeout(r, 300)); // let bash install the trap before we signal it
	const pid = h.children.get("r")?.pid as number;
	const started = Date.now();
	const res = await h.abort("r");
	assert.deepEqual(res, { result: "killed", killed: true, signal: "SIGKILL", exited: true });
	assert.ok(Date.now() - started < 9000, "worst case stays under the hub's budget");
	assert.equal(pidAlive(pid), false);
});

test("(f) unknown jobId over HTTP: not_running", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	assert.deepEqual(await h.abort("never-existed"), { result: "not_running", killed: false, signal: null, exited: false });
});

test("(g) response shape on a finished job, and 401 / 400 behaviour is unchanged", async (t) => {
	const h = await harness();
	t.after(() => h.close());
	await h.submit("done", "quick", "done");
	await waitFor(() => h.callbacks.includes("done"), "quick job to finish");
	const res = await h.abort("done");
	assert.deepEqual(Object.keys(res).sort(), ["exited", "killed", "result", "signal"]);
	assert.equal(res.result, "not_running");

	assert.equal((await h.post(`/hook/${HOOK}/abort`, { jobId: "done" }, "wrong")).status, 401);
	assert.equal((await h.post(`/hook/${HOOK}/abort`, {})).status, 400);
	assert.equal((await h.post("/hook/nope/abort", { jobId: "x" })).status, 404);
});
