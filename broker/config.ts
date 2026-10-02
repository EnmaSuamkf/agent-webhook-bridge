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

/**
 * Where a hook's agent runs. Absent from a hook means the historical
 * behaviour — spawn the CLI directly on the host, as your user, on your real
 * filesystem — so every hooks.json written before this existed stays valid.
 *
 * `kind: "docker"` runs the very same argv inside `docker run --rm` instead,
 * with the hook's workdir bind-mounted at its own absolute path (the paths
 * must be identical inside and outside, or the caller can no longer find the
 * transcripts the harness writes). See adapters/spawn-runner/sandbox.ts for
 * the argv this turns into, and why each flag is there.
 */
export interface DockerSandbox {
	kind: "docker";
	/** Image to run the agent CLI in. Per hook on purpose: a Python repo and a Node repo want different toolchains. */
	image: string;
	/** `--user` value. Defaults to the broker's own uid:gid, so files the agent creates in the workdir are owned by the operator, not root. */
	user?: string;
	/** Extra environment: `"NAME"` forwards the broker's own value, `"NAME=value"` sets one outright. */
	env?: string[];
	/** Extra host paths to bind-mount, each at its own absolute path. Every entry is a hole in the sandbox — the workdir and harness state are mounted already. */
	mounts?: string[];
	/** `--memory` (default `SANDBOX_LIMITS.memory`). */
	memory?: string;
	/** `--cpus` (default `SANDBOX_LIMITS.cpus`). */
	cpus?: string;
	/** `--pids-limit` (default `SANDBOX_LIMITS.pidsLimit`). */
	pidsLimit?: number;
}

export type SandboxConfig = DockerSandbox;

/**
 * Resource caps applied to every sandboxed run unless the hook overrides
 * them. The main defence against a runaway agent: without them a container
 * can take the whole machine down with it, which is a worse failure than the
 * host spawn it replaced.
 */
export const SANDBOX_LIMITS = {
	memory: "4g",
	cpus: "2",
	pidsLimit: 512,
} as const;

export interface HookConfig {
	mode: HookMode;
	/** Shared secret expected in the X-Webhook-Secret header. */
	secret?: string;
	/** Secret used to verify an HMAC-SHA256 signature of the raw body (X-Signature: sha256=<hex>). */
	hmacSecret?: string;
	/** Output adapters that consume this hook's events, e.g. ["spawn:claude"], ["queue"]; spawn:<claude|free-code|cursor|copilot>. */
	consumers: string[];
	/** Template for prompts sent to spawned agents. {{payload}} and {{hook}} are interpolated. */
	promptTemplate?: string;
	/** Working directory for spawned agent processes. Defaults to the broker's cwd. */
	workdir?: string;
	/**
	 * Passed through as claude's `--permission-mode`. Headless runs (no TTY) can't
	 * answer a permission prompt, so without this any Write/Edit/Bash the model
	 * attempts is auto-denied. Unset by default — opt in per hook once you trust
	 * what that hook's prompt asks the agent to do. Each non-claude adapter maps
	 * it to its own flags; copilot: unset/manual/plan = read-only,
	 * acceptEdits = edits but no shell, auto/dontAsk = --allow-all-tools (cwd +
	 * /tmp), bypassPermissions = --allow-all.
	 */
	permissionMode?: PermissionMode;
	/**
	 * Run spawned claude invocations in a visible gnome-terminal window
	 * instead of hidden/piped-to-logfile. Streams live (forces
	 * --output-format text instead of json, which only prints once at the
	 * end). Falls back to hidden if gnome-terminal isn't installed.
	 */
	visible?: boolean;
	/**
	 * Where the spawned agent runs. Unset (the default) = directly on the
	 * host, exactly as before. Set to a docker sandbox and the same argv is
	 * wrapped in `docker run --rm` by `wrapForSandbox`. Orthogonal to
	 * `consumers`: the consumer picks WHICH CLI runs, this picks WHERE, so
	 * both spawn adapters get containment from the same code.
	 */
	sandbox?: SandboxConfig;
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
