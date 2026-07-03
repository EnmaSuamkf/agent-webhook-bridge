/**
 * Persisted configuration for the broker.
 *
 * File: ~/.agent-webhook-bridge/hooks.json (override the directory with
 * AWB_HOME, useful for tests).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HookMode = "queue" | "trigger";

/** Mirrors claude's own `--permission-mode` choices. */
export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";

export const PERMISSION_MODES: PermissionMode[] = [
	"acceptEdits",
	"auto",
	"bypassPermissions",
	"manual",
	"dontAsk",
	"plan",
];

export interface HookConfig {
	mode: HookMode;
	/** Shared secret expected in the X-Webhook-Secret header. */
	secret?: string;
	/** Secret used to verify an HMAC-SHA256 signature of the raw body (X-Signature: sha256=<hex>). */
	hmacSecret?: string;
	/** Output adapters that consume this hook's events, e.g. ["spawn:claude"], ["queue"]. */
	consumers: string[];
	/** Template for prompts sent to spawned agents. {{payload}} and {{hook}} are interpolated. */
	promptTemplate?: string;
	/** Working directory for spawned agent processes. Defaults to the broker's cwd. */
	workdir?: string;
	/**
	 * Passed through as claude's `--permission-mode`. Headless runs (no TTY) can't
	 * answer a permission prompt, so without this any Write/Edit/Bash the model
	 * attempts is auto-denied. Unset by default — opt in per hook once you trust
	 * what that hook's prompt asks the agent to do.
	 */
	permissionMode?: PermissionMode;
}

export interface BridgeConfig {
	host: string;
	port: number;
	maxBodyBytes: number;
	publicBaseUrl: string | null;
	hooks: Record<string, HookConfig>;
}

// Default kept away from free-code's webhook-receiver default port range
// (8787-8806) so both can run on the same machine without a manual override.
const DEFAULTS: BridgeConfig = {
	host: "127.0.0.1",
	port: 8890,
	maxBodyBytes: 1024 * 1024,
	publicBaseUrl: null,
	hooks: {},
};

export function bridgeDir(): string {
	return process.env.AWB_HOME ?? path.join(os.homedir(), ".agent-webhook-bridge");
}

function configFile(): string {
	return path.join(bridgeDir(), "hooks.json");
}

export function dbFile(): string {
	return path.join(bridgeDir(), "events.db");
}

export function logsDir(): string {
	return path.join(bridgeDir(), "logs");
}

export function loadConfig(): BridgeConfig {
	let fileCfg: Partial<BridgeConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<BridgeConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}
	return {
		...DEFAULTS,
		...fileCfg,
		hooks: { ...(fileCfg.hooks ?? {}) },
	};
}

export function saveConfig(cfg: BridgeConfig): void {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
