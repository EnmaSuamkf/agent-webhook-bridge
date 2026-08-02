/**
 * Tests for the result-callback payload (broker/dispatch.ts `callbackPayload`).
 *
 * The bug this pins: the payload carried `ok`/`exitCode`/`mode` and nothing
 * else, so a caller that got a failed run learned only that it had failed.
 * Every distinct cause — a bad flag, a missing credential, a prompt that
 * overflowed the model's context window — arrived as the same `exit 1`, and
 * `exit 1` is the least diagnosable thing a failure can say. The CLI DOES print
 * why it died; that text just never left the broker.
 *
 * So: a failed run forwards the CLI's own words, and a successful one is
 * unchanged, byte for byte, from what it always sent.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { RunResult } from "../adapters/spawn-runner/shared.ts";
import { callbackPayload } from "./dispatch.ts";

function run(overrides: Partial<RunResult>): RunResult {
	return { ok: true, mode: "new", exitCode: 0, logFile: "/tmp/run.log", ...overrides };
}

test("a successful run's payload is exactly what it always was", () => {
	const payload = callbackPayload(
		run({ stdout: JSON.stringify({ result: "all done", session_id: "sess-1" }) }),
	);
	assert.deepEqual(payload, { ok: true, exitCode: 0, mode: "new", result: "all done", session_id: "sess-1" });
	assert.ok(!("error" in payload), "nothing went wrong, so nothing is claimed to have");
});

test("a failed run forwards the CLI's actual stderr instead of a bare exit code", () => {
	// The case the hub cares about most: a context overflow on a conversation
	// that has been reused for every step of a workflow.
	const stderr =
		"API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\"," +
		'"message":"prompt is too long: 412345 tokens > 200000 maximum"}}';
	const payload = callbackPayload(run({ ok: false, exitCode: 1, stderr }));

	assert.equal(payload.ok, false);
	assert.equal(payload.exitCode, 1);
	assert.equal(payload.error, stderr, "the caller can now read WHY, not just THAT");
	assert.equal(payload.logFile, "/tmp/run.log", "and can point at the full output");
});

test("a structured {\"error\":…} on stdout beats stderr", () => {
	// A CLI that says precisely what went wrong in its own envelope has already
	// done the work; the stderr tail is the fallback, not the preference.
	const payload = callbackPayload(
		run({
			ok: false,
			exitCode: 2,
			stdout: JSON.stringify({ error: "credentials expired", session_id: "sess-9" }),
			stderr: "  at Object.<anonymous> (/usr/lib/node_modules/…)\nnode:internal/errors",
		}),
	);
	assert.equal(payload.error, "credentials expired");
	assert.equal(payload.session_id, "sess-9", "the session still comes through, so the chain isn't lost");
});

test("the error is the TAIL of stderr — the fatal message comes last, the chatter first", () => {
	const chatter = "warming up\n".repeat(2000);
	const payload = callbackPayload(run({ ok: false, exitCode: 1, stderr: `${chatter}FATAL: out of context` }));
	const error = String(payload.error);
	assert.ok(error.endsWith("FATAL: out of context"));
	assert.ok(error.length <= 4000, "capped: a callback body is not a log file");
});

test("a failure with nothing to say sets no error, so the caller's own fallback stands", () => {
	// Visible mode pipes everything through `tee` in the terminal, so this
	// process captures neither stream. Inventing "exit 1" here would just move
	// the hub's existing fallback one layer down while saying nothing new.
	const payload = callbackPayload(run({ ok: false, exitCode: 1 }));
	assert.ok(!("error" in payload));
	assert.equal(payload.exitCode, 1);
});

test("a run that failed after producing output keeps both the result and the error", () => {
	const payload = callbackPayload(
		run({ ok: false, exitCode: 1, stdout: JSON.stringify({ result: "partial work", session_id: "sess-2" }), stderr: "killed" }),
	);
	assert.equal(payload.result, "partial work");
	assert.equal(payload.session_id, "sess-2", "the hub needs this to keep the workflow on one conversation");
	assert.equal(payload.error, "killed");
});
