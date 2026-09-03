#!/usr/bin/env node
/**
 * Broker daemon entry point. Run directly (`node broker/daemon.ts`) or via
 * `awb start`; stays alive listening for webhook POSTs and dispatching them.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { dispatch } from "./dispatch.ts";
import { createServer } from "./server.ts";

function log(message: string, type: "info" | "warning" | "error" = "info"): void {
	const prefix = type === "error" ? "[error]" : type === "warning" ? "[warn]" : "[info]";
	console.log(`${prefix} ${message}`);
}

export function startBroker(): void {
	const initial = loadConfig();
	if (Object.keys(initial.hooks).length === 0) {
		log("no hooks registered yet -- use `awb add <name>`", "warning");
	}

	const server = createServer({
		// Re-read on every request so hooks added with `awb add` while the
		// daemon is running take effect without a restart.
		getConfig: loadConfig,
		onEvent: (name, hook, event) => dispatch(name, hook, event, log),
		log,
	});

	server.listen(initial.port, initial.host, () => {
		log(`listening on http://${initial.host}:${initial.port}`);
	});
	server.on("error", (err) => {
		log(`server error: ${String(err)}`, "error");
		process.exitCode = 1;
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	startBroker();
}
