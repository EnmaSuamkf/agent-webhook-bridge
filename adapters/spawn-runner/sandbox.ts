/**
 * Optional containment for the spawn-runner adapters.
 *
 * `wrapForSandbox` takes the (binary, args) pair an adapter already built and,
 * when the hook asks for it, returns the same command re-expressed as a
 * `docker run --rm …` invocation. The broker itself never moves: it still
 * spawns on the host, still holds the workdir `flock`, still owns the log
 * file, still posts the callback. Only the process boundary around the agent
 * CLI changes — which is what keeps `dispatch.ts`, the abort path and every
 * consumer untouched by this feature.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **Path identity.** The workdir is mounted at its OWN absolute path and
 *     `-w`'d to that same path, and the harness's home state is mounted at its
 *     own absolute path too. Callers (e.g. the AgentMesh hub) locate a run's
 *     transcripts by slugifying the workdir string; mount the repo at
 *     `/workspace` instead and nothing errors — the transcripts simply land
 *     under a slug nobody is watching, and every run looks stalled.
 *  2. **Mounts come from the hook, never from the event body.** The hook is
 *     operator-configured; the body is whatever an HTTP caller posted.
 *     Deriving a mount from the payload would turn a webhook into arbitrary
 *     host filesystem access. Nothing in this file reads a `WebhookEvent`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bridgeDir, SANDBOX_LIMITS, type HookConfig } from "../../broker/config.ts";

const DOCKER = "docker";

/** The rewritten command to spawn: same shape the adapters hand to `runHidden`/`runVisible`. */
export interface SandboxedCommand {
	binary: string;
	args: string[];
}

/**
 * `uid:gid` of the broker process, so files the agent writes into the
 * bind-mounted workdir belong to the operator instead of root (root-owned
 * files in a real checkout need `sudo` to clean up, and can make parts of the
 * transcript tree unreadable to the hub). Empty on platforms without POSIX
 * ids, where `--user` is then omitted rather than guessed.
 */
export function hostUser(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const gid = typeof process.getgid === "function" ? process.getgid() : null;
	return uid === null || gid === null ? "" : `${uid}:${gid}`;
}

/**
 * Host paths holding the harness's own state, each mounted at its own path so
 * a session started inside the container is the same session the host can
 * resume and the same transcript the hub reads:
 *
 *  - `~/.claude` — Claude Code's config, credentials and `projects/<slug>/`
 *    transcripts. This is the mount the progress watchdog depends on.
 *  - `~/.claude.json` — Claude Code's top-level config file. `$HOME` itself is
 *    NOT mounted (that would hand the container the operator's whole home), so
 *    without this the agent has nowhere to write it.
 *  - `~/.free-code` — free-code's config, credentials, models and profiles.
 *    Not optional and not read-only: `runMigrations()` runs on every start and
 *    `mkdir`s `agent/themes/bundled` under it before any credential is read, so
 *    without this mount a free-code sandbox dies with `EACCES … mkdir
 *    '$HOME/.free-code/agent/themes/bundled'` — and `--no-themes` does not skip
 *    it. `$HOME` itself is never mounted, so the directory has to be named.
 *  - `<bridgeDir>/sessions` — free-code resumes by absolute `.jsonl` path, so
 *    that path has to resolve inside the container too. Only the sessions
 *    subdirectory: the bridge dir itself holds `hooks.json`, i.e. every hook's
 *    shared secret, which the agent has no business reading.
 *  - `~/.cursor` — Cursor Agent's config, credentials, chat databases and
 *    MCP settings. Sessions resume by uuid scoped to `--workspace`, so the
 *    chats tree has to be visible at the same absolute path inside the
 *    container.
 *
 * The list is not conditioned on which harness the hook runs: a claude sandbox
 * already gets the free-code sessions dir, and a free-code sandbox already gets
 * `~/.claude` with its credentials. Mounting both harnesses' state either way
 * keeps that posture symmetric instead of adding a half-measure.
 *
 * Entries that don't exist on the host are skipped — a bind mount of a
 * missing source makes docker create a root-owned directory in its place,
 * which is worse than not mounting it.
 */
export function harnessStateMounts(): string[] {
	return [
		path.join(os.homedir(), ".claude"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".free-code"),
		path.join(os.homedir(), ".cursor"),
		path.join(bridgeDir(), "sessions"),
	].filter((p) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	});
}

/**
 * The `docker run …` argv (everything up to and including the image) for a
 * run of `binary` in `workdir`. Exported so callers that need to show an
 * equivalent command — e.g. a "resume this session in a terminal" button —
 * can build one that really works, instead of a hand-written approximation
 * that drifts from what the broker actually runs.
 */
export function dockerRunArgs(sandbox: NonNullable<HookConfig["sandbox"]>, workdir: string, extraFlags: string[] = []): string[] {
	const args = ["run", "--rm"];
	// PID 1 that reaps zombies and, crucially, forwards the SIGTERM the docker
	// client proxies on abort down to the agent CLI — without it the signal
	// stops at a process that ignores it and the container outlives the abort.
	args.push("--init");
	const user = sandbox.user ?? hostUser();
	if (user) args.push("--user", user);
	args.push("--memory", sandbox.memory ?? SANDBOX_LIMITS.memory);
	args.push("--cpus", sandbox.cpus ?? SANDBOX_LIMITS.cpus);
	args.push("--pids-limit", String(sandbox.pidsLimit ?? SANDBOX_LIMITS.pidsLimit));
	args.push(...extraFlags);

	// Rule 1: same path in and out, for the workdir and for everything the
	// harness keys off an absolute path.
	for (const mount of [workdir, ...harnessStateMounts(), ...(sandbox.mounts ?? [])]) {
		args.push("-v", `${mount}:${mount}`);
	}
	// `--user` bypasses the image's own HOME, and $HOME is what the harness
	// resolves `~/.claude` from — point it at the host home whose `.claude` we
	// just mounted, or the container writes its state somewhere nobody reads.
	args.push("-e", `HOME=${os.homedir()}`);
	for (const entry of sandbox.env ?? []) args.push("-e", entry);

	args.push("-w", workdir);
	args.push(sandbox.image);
	return args;
}

/**
 * Rewrites `(binary, args)` for the hook's sandbox. A hook without a
 * `sandbox` block — every hook that predates this feature — comes back
 * byte-identical, so the host path is not just the default but literally
 * unchanged code.
 *
 * The workdir is resolved the same way the adapters resolve their `cwd`
 * (`hook.workdir ?? process.cwd()`), because that is the path the run's
 * artifacts will be filed under.
 */
export function wrapForSandbox(binary: string, args: string[], hook: HookConfig): SandboxedCommand {
	const sandbox = hook.sandbox;
	if (!sandbox || sandbox.kind !== "docker") return { binary, args };
	const workdir = path.resolve(hook.workdir ?? process.cwd());
	return { binary: DOCKER, args: [...dockerRunArgs(sandbox, workdir), binary, ...args] };
}
