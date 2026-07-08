/**
 * Routes a verified webhook event to its configured consumers and records
 * delivery state in SQLite. `spawn:claude` runs are serialized per working
 * directory (PLAN.md section 8 risk: "no pisar" two agent runs on the same
 * repo) so two events never spawn concurrent Claude sessions on one workdir.
 *
 * Result callback: if the event body carries a `callbackUrl`, the run's
 * outcome is POSTed there when the spawn finishes, so async callers (e.g. an
 * AgentMesh hub) can close the loop without polling logs. Only loopback URLs
 * are accepted for now — anything else would let a caller use the broker as
 * a proxy to arbitrary hosts. The callback is best-effort: the log file and
 * SQLite remain the source of truth if it fails.
 */
import { runClaude } from "../adapters/spawn-runner/claude.ts";
import type { ClaudeRunResult } from "../adapters/spawn-runner/claude.ts";
import type { HookConfig } from "./config.ts";
import { insertEvent, markDelivered, markFailed } from "./db.ts";
import type { WebhookEvent } from "./types.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const CALLBACK_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function callbackUrlFrom(event: WebhookEvent, log: Logger): URL | null {
	if (typeof event.body !== "object" || event.body === null) return null;
	const raw = (event.body as Record<string, unknown>).callbackUrl;
	if (typeof raw !== "string") return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		log(`'${event.hook}': ignoring malformed callbackUrl`, "warning");
		return null;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
		log(`'${event.hook}': ignoring non-loopback callbackUrl (${url.origin})`, "warning");
		return null;
	}
	return url;
}

/**
 * Shapes what gets POSTed to `callbackUrl`. Hidden runs use `--output-format
 * json`, so stdout is Claude's result envelope — `result` and `session_id`
 * are lifted out of it. If stdout isn't parseable JSON (visible mode logs a
 * `text` transcript through `tee`, so there's no stdout here at all), the
 * caller still gets `ok`/`exitCode` and can fall back to the broker log.
 */
function callbackPayload(run: ClaudeRunResult): Record<string, unknown> {
	const payload: Record<string, unknown> = { ok: run.ok, exitCode: run.exitCode, mode: run.mode };
	if (!run.stdout) return payload;
	try {
		const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
		payload.result = parsed.result;
		payload.session_id = parsed.session_id;
	} catch {
		payload.result = run.stdout;
	}
	return payload;
}

async function postCallback(url: URL, payload: unknown, hook: string, log: Logger): Promise<void> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				redirect: "error",
				signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
			});
			if (res.ok) {
				log(`'${hook}': callback delivered (${res.status})`);
				return;
			}
			log(`'${hook}': callback attempt ${attempt} got ${res.status}`, "warning");
		} catch (err) {
			log(`'${hook}': callback attempt ${attempt} failed: ${String(err)}`, "warning");
		}
	}
	log(`'${hook}': callback gave up after 2 attempts — see the run log for the result`, "error");
}

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
			const callbackUrl = callbackUrlFrom(event, log);
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
					if (callbackUrl) await postCallback(callbackUrl, callbackPayload(result), name, log);
				} catch (err) {
					markFailed(id, String(err));
					log(`'${name}' -> claude spawn error: ${String(err)}`, "error");
					if (callbackUrl) await postCallback(callbackUrl, { ok: false, error: String(err) }, name, log);
				}
			});
			continue;
		}

		// "queue"/other consumers: persisted above, pulled later by a future MCP adapter (roadmap phase 2).
		log(`'${name}' -> stored for consumer '${consumer}'`);
	}
}
