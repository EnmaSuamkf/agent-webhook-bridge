#!/usr/bin/env node
/**
 * `awb` — CLI to manage the agent-webhook-bridge broker: register hooks,
 * inspect their status, and fire a local test event without leaving the
 * terminal (PLAN.md section 7, phase 1: "Validar end-to-end con curl").
 */
import * as crypto from "node:crypto";
import { startBroker } from "../broker/daemon.ts";
import {
	type BridgeConfig,
	type HookConfig,
	type HookMode,
	loadConfig,
	PERMISSION_MODES,
	type PermissionMode,
	saveConfig,
} from "../broker/config.ts";
import { listEvents } from "../broker/db.ts";

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

function usage(): void {
	console.log(`Usage: awb <command> [args]

Commands:
  start                                  Run the broker (foreground)
  add <name> [options]                   Register a hook
    --trigger | --queue                  Delivery mode (default: trigger)
    --consumer <c>                       Repeatable; default spawn:claude for trigger, queue otherwise
    --prompt-template <text>             Prompt template for spawned agents ({{payload}}, {{hook}})
    --workdir <dir>                      cwd for spawned agent processes
    --secret <s> | --hmac-secret <s>     Auth secret (random shared secret generated if omitted)
    --permission-mode <mode>             claude --permission-mode for spawned runs (${PERMISSION_MODES.join(", ")}).
                                          Unset by default -- headless runs have no TTY, so any
                                          Write/Edit/Bash the model attempts is auto-denied unless
                                          you opt in here. acceptEdits is the least-risky opt-in.
  rm <name>                              Remove a hook
  list                                   List hooks
  url <name>                             Show callback URL + auth header
  events [name]                          Show recently recorded events
  test <name> [--body <json>] [--session-id <id>]
                                          POST a local test event to the running broker
                                          (with --session-id, the spawn:claude adapter will
                                          use "claude --resume <id>" instead of "claude -p")
`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i === -1 || i === args.length - 1) return undefined;
	return args[i + 1];
}

function flagValues(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
	}
	return out;
}

function describeHook(name: string, hook: HookConfig, cfg: BridgeConfig): string {
	const url = `http://${cfg.host}:${cfg.port}/hook/${encodeURIComponent(name)}`;
	const publicUrl = cfg.publicBaseUrl
		? `${cfg.publicBaseUrl.replace(/\/$/, "")}/hook/${encodeURIComponent(name)}`
		: null;
	return [
		`Hook '${name}' [${hook.mode}] consumers=${hook.consumers.join(",")}`,
		`Local URL:  ${url}`,
		...(publicUrl ? [`Public URL: ${publicUrl}`] : []),
		hook.secret ? `Header:     X-Webhook-Secret: ${hook.secret}` : "",
		hook.hmacSecret ? "HMAC:       X-Signature: sha256=<hmac-sha256(hmacSecret, rawBody)>" : "",
		hook.workdir ? `Workdir:    ${hook.workdir}` : "",
		hook.permissionMode ? `Permission: ${hook.permissionMode}` : "",
		hook.promptTemplate ? `Prompt:     ${hook.promptTemplate}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function main(): Promise<void> {
	const [, , cmd, ...rest] = process.argv;

	if (!cmd || cmd === "-h" || cmd === "--help") {
		usage();
		return;
	}

	if (cmd === "start") {
		startBroker();
		return;
	}

	const cfg = loadConfig();

	if (cmd === "list") {
		const names = Object.keys(cfg.hooks);
		if (names.length === 0) {
			console.log("No hooks registered. Use `awb add <name>`.");
			return;
		}
		for (const name of names.sort()) console.log(`${describeHook(name, cfg.hooks[name], cfg)}\n`);
		return;
	}

	if (cmd === "add") {
		const name = rest[0];
		if (!name || !VALID_NAME.test(name)) {
			console.error("Invalid or missing name. Allowed: A-Z a-z 0-9 . _ -");
			process.exitCode = 1;
			return;
		}
		const mode: HookMode = rest.includes("--queue") ? "queue" : "trigger";
		const consumers = flagValues(rest, "--consumer");
		let secret = flagValue(rest, "--secret");
		const hmacSecret = flagValue(rest, "--hmac-secret");
		if (!secret && !hmacSecret) secret = crypto.randomBytes(24).toString("hex");
		const promptTemplate = flagValue(rest, "--prompt-template");
		const workdir = flagValue(rest, "--workdir");
		const permissionModeArg = flagValue(rest, "--permission-mode");
		if (permissionModeArg && !PERMISSION_MODES.includes(permissionModeArg as PermissionMode)) {
			console.error(`Invalid --permission-mode '${permissionModeArg}'. Choices: ${PERMISSION_MODES.join(", ")}`);
			process.exitCode = 1;
			return;
		}
		const permissionMode = permissionModeArg as PermissionMode | undefined;

		const hook: HookConfig = {
			mode,
			consumers: consumers.length > 0 ? consumers : mode === "trigger" ? ["spawn:claude"] : ["queue"],
			...(secret ? { secret } : {}),
			...(hmacSecret ? { hmacSecret } : {}),
			...(promptTemplate ? { promptTemplate } : {}),
			...(workdir ? { workdir } : {}),
			...(permissionMode ? { permissionMode } : {}),
		};
		cfg.hooks[name] = hook;
		saveConfig(cfg);
		console.log(describeHook(name, hook, cfg));
		return;
	}

	if (cmd === "rm") {
		const name = rest[0];
		if (!name || !cfg.hooks[name]) {
			console.error(`Hook '${name}' does not exist.`);
			process.exitCode = 1;
			return;
		}
		delete cfg.hooks[name];
		saveConfig(cfg);
		console.log(`Hook '${name}' removed.`);
		return;
	}

	if (cmd === "url") {
		const name = rest[0];
		if (!name || !cfg.hooks[name]) {
			console.error(`Hook '${name}' does not exist.`);
			process.exitCode = 1;
			return;
		}
		console.log(describeHook(name, cfg.hooks[name], cfg));
		return;
	}

	if (cmd === "events") {
		const name = rest[0];
		const events = listEvents(name, 20);
		if (events.length === 0) {
			console.log("No events recorded yet.");
			return;
		}
		for (const e of events) {
			console.log(
				`#${e.id} ${e.hook} [${e.consumer}] ${e.status} received=${e.receivedAt}${e.error ? ` error=${e.error}` : ""}`,
			);
		}
		return;
	}

	if (cmd === "test") {
		const name = rest[0];
		const hook = name ? cfg.hooks[name] : undefined;
		if (!name || !hook) {
			console.error(`Hook '${name}' does not exist.`);
			process.exitCode = 1;
			return;
		}
		const bodyArg = flagValue(rest, "--body") ?? JSON.stringify({ test: true, at: new Date().toISOString() });
		const sessionId = flagValue(rest, "--session-id");
		const url = `http://${cfg.host}:${cfg.port}/hook/${encodeURIComponent(name)}`;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (hook.secret) headers["x-webhook-secret"] = hook.secret;
		if (hook.hmacSecret) {
			headers["x-signature"] = `sha256=${crypto.createHmac("sha256", hook.hmacSecret).update(bodyArg).digest("hex")}`;
		}
		if (sessionId) headers.sessionid = sessionId;

		try {
			const res = await fetch(url, { method: "POST", headers, body: bodyArg });
			const text = await res.text();
			console.log(`${res.status} ${text}`);
		} catch (err) {
			console.error(`Could not reach broker at ${url}. Is it running (\`awb start\`)? ${String(err)}`);
			process.exitCode = 1;
		}
		return;
	}

	usage();
	process.exitCode = 1;
}

main();
