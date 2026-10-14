/**
 * Persistent event queue (SQLite via node:sqlite — no native deps needed on
 * Node 24+). Every verified webhook event is stored before delivery is
 * attempted, so nothing is lost if the broker restarts mid-delivery, and a
 * future MCP pull adapter (roadmap phase 2) has something to read from for
 * "queue" mode hooks.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { dbFile } from "./config.ts";
import type { WebhookEvent } from "./types.ts";

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface StoredEvent {
	id: number;
	hook: string;
	consumer: string;
	headers: Record<string, string>;
	body: unknown;
	receivedAt: string;
	deliveredAt: string | null;
	status: DeliveryStatus;
	error: string | null;
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
	if (db) return db;
	const file = dbFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	db = new DatabaseSync(file);
	db.exec(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			hook TEXT NOT NULL,
			consumer TEXT NOT NULL,
			headers TEXT NOT NULL,
			body TEXT NOT NULL,
			received_at TEXT NOT NULL,
			delivered_at TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			error TEXT
		);
		CREATE TABLE IF NOT EXISTS runs (
			hook TEXT NOT NULL,
			job_id TEXT NOT NULL,
			pid INTEGER NOT NULL,
			started_at TEXT NOT NULL,
			PRIMARY KEY (hook, job_id)
		);
	`);
	return db;
}

export function insertEvent(event: WebhookEvent, consumer: string): number {
	const stmt = open().prepare(
		"INSERT INTO events (hook, consumer, headers, body, received_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
	);
	const info = stmt.run(
		event.hook,
		consumer,
		JSON.stringify(event.headers),
		JSON.stringify(event.body),
		event.receivedAt,
	);
	return Number(info.lastInsertRowid);
}

export function markDelivered(id: number): void {
	open()
		.prepare("UPDATE events SET status = 'delivered', delivered_at = ? WHERE id = ?")
		.run(new Date().toISOString(), id);
}

export function markFailed(id: number, error: string): void {
	open()
		.prepare("UPDATE events SET status = 'failed', delivered_at = ?, error = ? WHERE id = ?")
		.run(new Date().toISOString(), error, id);
}

function rowToEvent(row: Record<string, unknown>): StoredEvent {
	return {
		id: Number(row.id),
		hook: String(row.hook),
		consumer: String(row.consumer),
		headers: JSON.parse(String(row.headers)),
		body: JSON.parse(String(row.body)),
		receivedAt: String(row.received_at),
		deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
		status: row.status as DeliveryStatus,
		error: row.error == null ? null : String(row.error),
	};
}

export function listEvents(hook?: string, limit = 50): StoredEvent[] {
	const rows = hook
		? open().prepare("SELECT * FROM events WHERE hook = ? ORDER BY id DESC LIMIT ?").all(hook, limit)
		: open().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
	return (rows as Record<string, unknown>[]).map(rowToEvent);
}

// --- Runs (in-flight spawn tracking, for abort) ---
//
// A row per spawned run keyed by (hook, job_id), carrying the child's process
// group leader pid so an external `POST /hook/:name/abort {jobId}` can kill the
// whole group (flock + bash + the agent binary). Persisted in events.db rather
// than kept in memory so a broker RESTART can still reach the pid of a run the
// previous broker instance spawned (the orphaned child still holds the workdir
// flock; without this row the new broker couldn't abort it). Rows are reaped
// when the run finishes (dispatch unregisters) or when a lookup finds the pid
// already dead, so the table doesn't grow without bound.

export interface StoredRun {
	hook: string;
	jobId: string;
	pid: number;
	startedAt: string;
}

/** Records an in-flight run so it can be aborted later. Overwrites any stale row for the same (hook, job_id). */
export function registerRun(hook: string, jobId: string, pid: number): void {
	open()
		.prepare("INSERT OR REPLACE INTO runs (hook, job_id, pid, started_at) VALUES (?, ?, ?, ?)")
		.run(hook, jobId, pid, new Date().toISOString());
}

/** Removes an in-flight run row (the run finished or was killed). No-op if absent. */
export function unregisterRun(hook: string, jobId: string): void {
	open().prepare("DELETE FROM runs WHERE hook = ? AND job_id = ?").run(hook, jobId);
}

/** Returns the in-flight run for (hook, job_id), reaping it first if its pid is already dead. */
export function findRun(hook: string, jobId: string): StoredRun | null {
	const row = open()
		.prepare("SELECT * FROM runs WHERE hook = ? AND job_id = ?")
		.get(hook, jobId) as Record<string, unknown> | undefined;
	if (!row) return null;
	const pid = Number(row.pid);
	if (!pidAlive(pid)) {
		unregisterRun(hook, jobId);
		return null;
	}
	return { hook: String(row.hook), jobId: String(row.job_id), pid, startedAt: String(row.started_at) };
}

/** Returns whether `pid` refers to a live process (signal 0 probe; never throws). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Escalation waits, in order: SIGINT (the Claude CLI stops its turn and flushes
 * the transcript on it), SIGTERM, SIGKILL. Worst case 2+3+2 = 7s (plus one poll
 * interval per step), kept under the hub's 15s abort request timeout.
 */
const SIGINT_WAIT_MS = 2000;
const SIGTERM_WAIT_MS = 3000;
const SIGKILL_WAIT_MS = 2000;
const KILL_POLL_MS = 100;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Syscall/clock seam for `killRun`, so tests can simulate a group that never
 * dies (`kill_failed`) with a fake clock instead of waiting out ~7s. Production
 * uses the real `process.kill`, `setTimeout` and `Date.now`.
 */
export interface KillOps {
	kill(pid: number, signal: NodeJS.Signals | 0): void;
	wait(ms: number): Promise<void>;
	now(): number;
}

const REAL_KILL_OPS: KillOps = { kill: (pid, signal) => process.kill(pid, signal), wait, now: Date.now };

/** Returns whether any process of the group led by `pid` is still alive (never throws). */
function groupAlive(pid: number, ops: KillOps): boolean {
	try {
		ops.kill(-pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type KillSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface KillOutcome {
	/** killed: group signalled and verified gone. not_running: no live run. kill_failed: still alive after SIGKILL + wait. */
	result: "killed" | "not_running" | "kill_failed";
	/** The signal that finished the job (the one after which the group was gone), or the last one tried on failure; null if none was sent. */
	signal: KillSignal | null;
	/** True only when the process group was verified gone. */
	exited: boolean;
}

/**
 * Kills the in-flight run for (hook, job_id) — its whole process group, so the
 * flock wrapper, the bash `-c` shim, AND the spawned agent binary all die
 * together (the binary is what holds the workdir flock, so killing the group
 * is what actually frees the workdir for the next run). Escalates SIGINT ->
 * SIGTERM -> SIGKILL, waiting for the group to vanish after each, and never
 * reports `killed` unless the group is verified gone (`exited: true`); the run
 * row is removed only then. If the group survives SIGKILL the row is kept and
 * the result is `kill_failed`, so the caller can retry or surface it.
 */
export async function killRun(hook: string, jobId: string, ops: KillOps = REAL_KILL_OPS): Promise<KillOutcome> {
	const run = findRun(hook, jobId);
	if (!run) return { result: "not_running", signal: null, exited: false };
	const steps: Array<[KillSignal, number]> = [
		["SIGINT", SIGINT_WAIT_MS],
		["SIGTERM", SIGTERM_WAIT_MS],
		["SIGKILL", SIGKILL_WAIT_MS],
	];
	let last: KillSignal | null = null;
	for (const [signal, waitMs] of steps) {
		try {
			ops.kill(-run.pid, signal);
		} catch (err) {
			// ESRCH = the group is already gone; anything else (EPERM) we can't fix, keep escalating/verifying.
			if ((err as NodeJS.ErrnoException).code === "ESRCH") {
				unregisterRun(hook, jobId);
				return { result: "killed", signal: last ?? signal, exited: true };
			}
		}
		last = signal;
		const deadline = ops.now() + waitMs;
		while (ops.now() < deadline) {
			await ops.wait(KILL_POLL_MS);
			if (!groupAlive(run.pid, ops)) {
				unregisterRun(hook, jobId);
				return { result: "killed", signal, exited: true };
			}
		}
	}
	return { result: "kill_failed", signal: last, exited: !groupAlive(run.pid, ops) };
}
