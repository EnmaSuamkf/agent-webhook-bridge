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
