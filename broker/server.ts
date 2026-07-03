/**
 * HTTP listener for the broker.
 *
 * Routes:
 *   GET  /health        → liveness + list of configured hook names
 *   POST /hook/:name    → deliver an event to the registered hook `:name`
 *
 * Authentication is mandatory per hook: either a shared secret
 * (`X-Webhook-Secret`) or an HMAC-SHA256 signature of the raw body
 * (`X-Signature: sha256=<hex>`). Bodies larger than `maxBodyBytes` are rejected.
 *
 * Ported from free-code's packages/coding-agent/default-extensions/webhook-receiver/_server.ts,
 * generalized to run standalone. `sessionid` is forwarded from headers so the
 * spawn:claude adapter can decide between `claude -p` and `claude --resume`.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { BridgeConfig, HookConfig } from "./config.ts";
import type { WebhookEvent } from "./types.ts";

export interface ServerDeps {
	getConfig: () => BridgeConfig;
	onEvent: (name: string, hook: HookConfig, event: WebhookEvent) => void;
	log: (message: string, type?: "info" | "warning" | "error") => void;
}

const FORWARDED_HEADERS = [
	"content-type",
	"user-agent",
	"sessionid",
	"x-event-type",
	"x-github-event",
	"x-gitlab-event",
];

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

function verifyAuth(hook: HookConfig, headers: http.IncomingHttpHeaders, rawBody: Buffer): boolean {
	// Auth is mandatory: a hook with no secret configured never authenticates.
	if (!hook.secret && !hook.hmacSecret) return false;

	if (hook.hmacSecret) {
		const provided = String(headers["x-signature"] ?? "").replace(/^sha256=/i, "");
		const expected = crypto.createHmac("sha256", hook.hmacSecret).update(rawBody).digest("hex");
		if (provided && timingSafeEqualStr(provided, expected)) return true;
	}
	if (hook.secret) {
		const provided = String(headers["x-webhook-secret"] ?? "");
		if (provided && timingSafeEqualStr(provided, hook.secret)) return true;
	}
	return false;
}

function pickHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of FORWARDED_HEADERS) {
		const value = headers[key];
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

export function createServer(deps: ServerDeps): http.Server {
	return http.createServer((req, res) => {
		const cfg = deps.getConfig();
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const parts = url.pathname.split("/").filter(Boolean);

		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { ok: true, hooks: Object.keys(cfg.hooks) });
			return;
		}

		if (req.method !== "POST" || parts[0] !== "hook" || !parts[1]) {
			sendJson(res, 404, { error: "not_found" });
			return;
		}

		const name = decodeURIComponent(parts[1]);
		const hook = cfg.hooks[name];
		if (!hook) {
			sendJson(res, 404, { error: "unknown_hook", name });
			return;
		}

		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;

		req.on("data", (chunk: Buffer) => {
			if (aborted) return;
			size += chunk.length;
			if (size > cfg.maxBodyBytes) {
				aborted = true;
				sendJson(res, 413, { error: "payload_too_large" });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (aborted) return;
			const rawBody = Buffer.concat(chunks);

			if (!verifyAuth(hook, req.headers, rawBody)) {
				deps.log(`hook '${name}': authentication failed`, "warning");
				sendJson(res, 401, { error: "unauthorized" });
				return;
			}

			const text = rawBody.toString("utf8");
			let body: unknown = text;
			if (String(req.headers["content-type"] ?? "").includes("application/json")) {
				try {
					body = JSON.parse(text || "null");
				} catch {
					// Keep the raw text if it is not valid JSON.
				}
			}

			const event: WebhookEvent = {
				hook: name,
				receivedAt: new Date().toISOString(),
				headers: pickHeaders(req.headers),
				body,
			};

			try {
				deps.onEvent(name, hook, event);
			} catch (err) {
				deps.log(`failed to deliver event for '${name}': ${String(err)}`, "error");
			}
			sendJson(res, 200, { ok: true });
		});

		req.on("error", () => {
			if (!aborted) sendJson(res, 400, { error: "bad_request" });
		});
	});
}
