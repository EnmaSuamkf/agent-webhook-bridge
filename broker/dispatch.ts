/**
 * Routes a verified webhook event to its configured consumers and records
 * delivery state in SQLite. `spawn:claude` runs are serialized per working
 * directory (PLAN.md section 8 risk: "no pisar" two agent runs on the same
 * repo) so two events never spawn concurrent Claude sessions on one workdir.
 */
import { runClaude } from "../adapters/spawn-runner/claude.ts";
import type { HookConfig } from "./config.ts";
import { insertEvent, markDelivered, markFailed } from "./db.ts";
import type { WebhookEvent } from "./types.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const workdirChains = new Map<string, Promise<void>>();

function runExclusive(key: string, task: () => Promise<void>): void {
	const prev = workdirChains.get(key) ?? Promise.resolve();
	const next = prev.then(task, task);
	workdirChains.set(key, next);
	next.finally(() => {
		if (workdirChains.get(key) === next) workdirChains.delete(key);
	});
}

export function dispatch(name: string, hook: HookConfig, event: WebhookEvent, log: Logger): void {
	for (const consumer of hook.consumers) {
		const id = insertEvent(event, consumer);

		if (consumer === "spawn:claude") {
			const key = hook.workdir ?? "default";
			runExclusive(key, async () => {
				try {
					const result = await runClaude(hook, event);
					if (result.ok) {
						markDelivered(id);
						log(`'${name}' -> claude (${result.mode}) ok, log: ${result.logFile}`);
					} else {
						markFailed(id, `exit ${result.exitCode}`);
						log(`'${name}' -> claude (${result.mode}) failed (exit ${result.exitCode}), log: ${result.logFile}`, "error");
					}
				} catch (err) {
					markFailed(id, String(err));
					log(`'${name}' -> claude spawn error: ${String(err)}`, "error");
				}
			});
			continue;
		}

		// "queue"/other consumers: persisted above, pulled later by a future MCP adapter (roadmap phase 2).
		log(`'${name}' -> stored for consumer '${consumer}'`);
	}
}
