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
import { runFreeCode } from "../adapters/spawn-runner/free-code.ts";
import type { RunResult } from "../adapters/spawn-runner/shared.ts";
import type { SpawnHook, StartedHook } from "../adapters/spawn-runner/shared.ts";
import type { HookConfig } from "./config.ts";
import { insertEvent, markDelivered, markFailed, registerRun, unregisterRun } from "./db.ts";
import type { WebhookEvent } from "./types.ts";

export type Logger = (message: string, type?: "info" | "warning" | "error") => void;

const CALLBACK_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackUrlFrom(event: WebhookEvent, field: string, log: Logger): URL | null {
	if (typeof event.body !== "object" || event.body === null) return null;
	const raw = (event.body as Record<string, unknown>)[field];
	if (typeof raw !== "string") return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		log(`'${event.hook}': ignoring malformed ${field}`, "warning");
		return null;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
		log(`'${event.hook}': ignoring non-loopback ${field} (${url.origin})`, "warning");
		return null;
	}
	return url;
}

/**
 * The job id the caller (e.g. the hub) attached to this event, used to key the
 * in-flight run row so a later `POST /hook/:name/abort {jobId}` can kill it.
 * Absent for callers that don't use the abort protocol (plain `curl`); those
 * runs just aren't abortable by id, everything else is unaffected.
 */
function jobIdFrom(event: WebhookEvent): string | null {
	if (typeof event.body !== "object" || event.body === null) return null;
	const raw = (event.body as Record<string, unknown>).jobId;
	return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * How much of the CLI's error text to forward. Enough for a real message
 * ("Prompt is too long: 412345 tokens > 200000 maximum" and a stack, say),
 * short enough that a callback body stays a callback body — the full text is in
 * the run log either way, and the log file path travels with every failure.
 */
const MAX_ERROR_CHARS = 4000;

/**
 * The run's error text, or undefined when it succeeded / said nothing.
 *
 * Order matters: a CLI that emits a structured `{"error": …}` on stdout has
 * already told us precisely what went wrong, so that wins; otherwise it's the
 * tail of stderr, which is where every CLI here prints its fatal message. The
 * exit code is deliberately NOT synthesised into a message — the hub already
 * falls back to `exit N` when there's no error, and inventing "exit 1" here
 * would just move that string one layer down while still saying nothing.
 */
function errorText(run: RunResult): string | undefined {
	if (run.ok) return undefined;
	if (run.stdout) {
		try {
			const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
			const structured = parsed.error;
			if (typeof structured === "string" && structured.trim()) return structured.trim().slice(0, MAX_ERROR_CHARS);
		} catch {
			// Not JSON — stderr below is the better source anyway.
		}
	}
	const stderr = run.stderr?.trim();
	return stderr ? stderr.slice(-MAX_ERROR_CHARS) : undefined;
}

/**
 * Shapes what gets POSTed to `callbackUrl`. Each adapter's `stdout` is a JSON
 * object with `result` and `session_id` — claude's `--output-format json`
 * envelope natively, free-code's NDJSON stream reshaped by its adapter into
 * the same shape. `result`/`session_id` are lifted out of it here. If stdout
 * isn't parseable JSON (visible mode logs a `text` transcript through `tee`,
 * so there's no stdout here at all), the caller still gets `ok`/`exitCode`
 * and can fall back to the broker log.
 *
 * A FAILED run also carries `error`: the CLI's own words about why it died.
 * Without it every failure — a bad flag, a missing credential, a context
 * overflow on a conversation that grew too long — reached the caller as a bare
 * `exit 1`, which is the least diagnosable thing a failure can say. `logFile`
 * rides along on a failure too, so the caller can point at the full output.
 *
 * Exported for the tests: this shape is the contract between the broker and
 * every async caller, and "does a failure carry its error text" is exactly the
 * kind of thing that silently regresses.
 */
export function callbackPayload(run: RunResult): Record<string, unknown> {
	const payload: Record<string, unknown> = { ok: run.ok, exitCode: run.exitCode, mode: run.mode };
	const error = errorText(run);
	if (error !== undefined) payload.error = error;
	if (!run.ok) payload.logFile = run.logFile;
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

/**
 * One-shot best-effort POST of `{started: true}` to the caller's
 * `startedCallbackUrl`, fired the moment the run actually begins (after the
 * workdir lock is acquired — see `runHidden`). The hub uses it to flip a
 * `queued` step to `running` and start its timeout clock at the true run start
 * instead of at dispatch acceptance, so a step queued behind another on the
 * same workdir isn't timed out while still waiting. Never retried: a missed
 * start just means the hub keeps the step `queued` (abortable, and eventually
 * failed by the hub's queued-timeout safety net).
 */
async function postStarted(url: URL, hook: string, log: Logger): Promise<void> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ started: true }),
			redirect: "error",
			signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
		});
		if (!res.ok) log(`'${hook}': started callback got ${res.status}`, "warning");
	} catch (err) {
		log(`'${hook}': started callback failed: ${String(err)}`, "warning");
	}
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

		if (consumer === "spawn:claude" || consumer === "spawn:free-code") {
			const key = hook.workdir ?? "default";
			const callbackUrl = loopbackUrlFrom(event, "callbackUrl", log);
			const startedUrl = loopbackUrlFrom(event, "startedCallbackUrl", log);
			const jobId = jobIdFrom(event);
			const runner = consumer === "spawn:free-code" ? runFreeCode : runClaude;
			const tag = consumer === "spawn:free-code" ? "free-code" : "claude";
			// Register the spawned process group leader so an external abort
			// (`POST /hook/:name/abort {jobId}`) can kill the whole group — flock,
			// the bash shim, and the agent binary — which is what actually frees
			// the workdir. Only keyed when the caller sent a `jobId` (the hub
			// always does); otherwise there's nothing to abort by id.
			const onSpawn: SpawnHook = (pid) => {
				if (jobId) registerRun(name, jobId, pid);
			};
			// Fire the `started` callback at the true run start (after the workdir
			// lock is acquired), so the hub can begin the step's timeout then.
			const onStarted: StartedHook = () => {
				if (startedUrl) void postStarted(startedUrl, name, log);
			};
			runExclusive(key, async () => {
				try {
					const result = await runner(hook, event, onSpawn, onStarted);
					if (result.ok) {
						markDelivered(id);
						log(`'${name}' -> ${tag} (${result.mode}) ok, log: ${result.logFile}`);
					} else {
						markFailed(id, `exit ${result.exitCode}`);
						log(`'${name}' -> ${tag} (${result.mode}) failed (exit ${result.exitCode}), log: ${result.logFile}`, "error");
					}
					if (callbackUrl) await postCallback(callbackUrl, callbackPayload(result), name, log);
				} catch (err) {
					markFailed(id, String(err));
					log(`'${name}' -> ${tag} spawn error: ${String(err)}`, "error");
					if (callbackUrl) await postCallback(callbackUrl, { ok: false, error: String(err) }, name, log);
				} finally {
					// The run is done (or died) — drop its row so a later abort for
					// this jobId is a clean no-op instead of killing a recycled pid.
					if (jobId) unregisterRun(name, jobId);
				}
			});
			continue;
		}

		// "queue"/other consumers: persisted above, pulled later by a future MCP adapter (roadmap phase 2).
		log(`'${name}' -> stored for consumer '${consumer}'`);
	}
}
