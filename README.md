# agent-webhook-bridge

A standalone HTTP broker that receives external webhooks (CI, GitHub, Flowise…) and wakes up a
coding agent — either as a brand-new session or by resuming an existing one — without the agent
having to be running beforehand.

Two runtimes are supported in the spawn adapter: **Claude Code** (the default) and **[free-code](https://github.com/EnmaSuamkf/free-code)**.
They share the same hook protocol (`secret`/`callbackUrl`/`sessionId`), so the broker, the AgentMesh hub, and the caller code stay runtime-agnostic — you just pick which CLI a hook spawns with `--runner`.

This is phase 1 of the roadmap (see [`PLAN.md`](PLAN.md)): broker + spawn adapter. The full guide with more examples lives in [`web-docs/index.html`](web-docs/index.html)
(open it in a browser); this README is the condensed version.

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Registering a hook](#registering-a-hook)
- [New session vs. resuming (`sessionId`)](#new-session-vs-resuming-sessionid)
- [Result callback (`callbackUrl`)](#result-callback-callbackurl)
- [Permissions in headless mode](#permissions-in-headless-mode)
- [Visible mode](#visible-mode)
- [Examples](#examples)
- [Checking status](#checking-status)
- [Security](#security)
- [Current limitations](#current-limitations)
- [free-code adapter](#free-code-adapter)
- [Command reference](#command-reference)

## Requirements

- **Node.js 24 or newer.** The broker uses `node:sqlite` (no native dependencies) and runs the
  `.ts` files directly — there's no build step.
- **Claude Code CLI** *and/or* **free-code CLI** installed and authenticated, with the `claude`
  and/or `free-code` binary on the `PATH` of the machine where the broker runs. A hook spawns
  whichever one its `--runner` selects (default `claude`), so you only need the binary/ies you
  actually use.

## Installation

Not published to npm yet: it's used straight from the repo checkout.

```bash
cd agent-webhook-bridge
npm install        # optional -- only brings in @types/node for the editor,
                    # not needed to run anything
```

To have the `awb` command available from any folder:

```bash
npm link           # creates the global symlink "awb" -> ./cli/awb.ts
```

If you'd rather not link it globally, every `awb …` command in this guide works the same as
`node cli/awb.ts …` run from the repo folder.

## Quickstart

```bash
# 1) start the broker (foreground)
awb start

# 2) in another terminal, register a hook
awb add ci-failures \
  --trigger \
  --workdir /path/to/your/repo \
  --prompt-template 'A CI build failed. Log:\n\n{{payload}}\n\nInvestigate the cause.'

# 3) test it without leaving the terminal
awb test ci-failures --body '{"branch":"main","step":"npm test","exitCode":1}'
```

The broker listens on `127.0.0.1:8890` by default (chosen on purpose to avoid clashing with
free-code's webhook-receiver, which uses 8787-8806). Configuration lives in
`~/.agent-webhook-bridge/hooks.json`, the event queue in `~/.agent-webhook-bridge/events.db`
(SQLite), and the logs of every Claude invocation in `~/.agent-webhook-bridge/logs/`. To use a
different location (tests, multiple instances), set `AWB_HOME=/your/path` before any `awb`
command.

The broker re-reads `hooks.json` on every request, so you can register or remove hooks with
`awb add`/`awb rm` while it keeps running, no restart needed.

## Registering a hook

```bash
awb add ci-failures \
  --trigger \
  --workdir /path/to/your/repo \
  --prompt-template 'A CI build failed. Log:\n\n{{payload}}\n\nInvestigate the cause.'
```

The output returns the local URL and the secret you need to configure in the external system:

```
Hook 'ci-failures' [trigger] consumers=spawn:claude
Local URL:  http://127.0.0.1:8890/hook/ci-failures
Header:     X-Webhook-Secret: 76171625f1dbab4647623cb7f6c99e18...
Workdir:    /path/to/your/repo
Prompt:     A CI build failed. Log:\n\n{{payload}}\n\nInvestigate the cause.
```

| Option | What it does |
|---|---|
| `--trigger` / `--queue` | Delivery mode. `trigger` (default) fires the spawn adapter as soon as the event arrives. `queue` only persists it in SQLite, for a future read adapter (see [Current limitations](#current-limitations)). |
| `--runner <claude\|free-code>` | Which CLI a `trigger` hook spawns. Default: `claude`. Shortcut for `--consumer spawn:claude` / `--consumer spawn:free-code`; an explicit `--consumer` wins. The two adapters share the same hook protocol (secret, `callbackUrl`, `sessionId`), so the broker and callers don't change — only the binary that gets spawned does. See [free-code adapter](#free-code-adapter) for the session/permission differences. |
| `--consumer <c>` | Repeatable. Default: `spawn:claude` for `trigger` (or `spawn:free-code` when `--runner free-code`), `queue` for `queue`. Use `spawn:free-code` to wake [free-code](https://github.com/EnmaSuamkf/free-code) instead of Claude Code. |
| `--prompt-template <text>` | Template for the prompt the spawned agent receives. `{{payload}}` is replaced with the event body (formatted as JSON if it isn't plain text); `{{hook}}` with the hook's name. |
| `--workdir <dir>` | `cwd` of the spawned process. It's also the key that serializes runs: two events with the same `workdir` never run in parallel on the same repo. |
| `--secret <s>` / `--hmac-secret <s>` | Authentication. If you don't provide either, a random one is generated. With `--hmac-secret` the caller signs the raw body instead of sending the secret in a header. |
| `--permission-mode <mode>` | For `--runner claude` this is passed straight through as claude's `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`). For `--runner free-code` it's mapped to that adapter's `--tools` flag (see [Permissions in headless mode](#permissions-in-headless-mode)). Without this, headless runs can't write or edit anything. |
| `--visible` | Runs the spawned agent (`claude` or `free-code`) in a visible gnome-terminal window instead of hidden (see [Visible mode](#visible-mode)). |

### The `curl` body is yours, not a fixed format

The bridge doesn't expect any particular field in the body — no `log`, no `branch`, nothing. You
decide what your external system sends; the broker just takes that body *as it arrived* and drops
it wherever `{{payload}}` appears in your `--prompt-template`. There's no field-by-field
substitution — it's a single block of text.

With the hook above, this request:

```bash
curl -X POST http://127.0.0.1:8890/hook/ci-failures \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <secret>" \
  -d '{"branch":"main","step":"npm test","exitCode":1}'
```

ends up building this exact prompt, which is what `claude -p` receives as its argument:

```
A CI build failed. Log:

{
  "branch": "main",
  "step": "npm test",
  "exitCode": 1
}

Investigate the cause.
```

Claude receives that JSON as plain text inside the prompt and interprets it itself — there's no
special parsing of `branch`/`step`/`exitCode` on the broker's side.

> **Tip:** if `Content-Type` isn't `application/json` or the body isn't valid JSON,
> `{{payload}}` still gets replaced, just with the raw text as-is — plain text in `-d` works
> fine too, it doesn't have to be JSON.

## New session vs. resuming (`sessionId`)

For hooks with a `spawn:*` consumer, the adapter decides how to launch the agent based on a
single header in the incoming request. Both adapters use the same header (`sessionId`), so the
caller's protocol is identical regardless of `--runner` — only the *value* differs: a Claude
Code session uuid for `claude`, a `.jsonl` path for `free-code`.

### `--runner claude` (default)

```
POST /hook/<name>
  sessionId header present?
    │
    ├─ no  → claude -p "<prompt>" --output-format json
    │        (starts a brand-new session)
    │
    └─ yes → claude --resume <sessionId> -p "<prompt>" --output-format json
             (resumes that existing session, with all its prior context)
```

For `--resume` to find the session, the hook's `--workdir` has to match the directory of the
project where that session was originally created — Claude Code sessions are tied to a working
directory.

> **Non-obvious detail:** `--resume <id>` without `-p`/`--print` opens Claude Code's interactive
> picker. In a spawned process with no TTY that hangs forever — that's why the adapter always
> adds `-p` on the resume branch too, not just on the new-session one.

### `--runner free-code`

free-code resumes by **.jsonl path**, not by a uuid. The adapter keeps every session file under
`~/.agent-webhook-bridge/sessions/<hook>/`, and the `session_id` it returns in the callback is
*that path* — so to continue a conversation you just send it back as the `sessionId` header,
exactly like with claude:

```
POST /hook/<name>
  sessionId header present?
    │
    ├─ no  → free-code -p "<prompt>" --mode json --session <minted .jsonl path>
    │        (a new file is created under sessions/<hook>/; its path comes back as session_id)
    │
    └─ yes → free-code -p "<prompt>" --mode json --session <sessionId header value>
             (resumes that exact file, with all its prior context)
```

A `sessionId` header that points outside `~/.agent-webhook-bridge/sessions/` is treated as
untrusted (path-traversal guard) and a fresh session starts instead — the broker never opens an
arbitrary caller-supplied path.

> **free-code's `--mode json` is not a single envelope** the way claude's `--output-format json`
> is: it emits an NDJSON event stream (a session header line, then one event per
> message/turn/tool). The adapter consumes that stream and reshapes it into the same
> `{result, session_id}` envelope the claude adapter produces, so the callback body and the
> AgentMesh hub see one uniform shape from either runtime.

### Where do I get the `sessionId` I need to send?

The broker and Claude don't invent it: it's the **caller** (your script, your Flowise flow, your
CI pipeline) that has to know it and send it as a literal HTTP header `sessionId: <uuid>` on the
`POST`. Three ways to get that UUID:

1. **From Claude itself, in the first response.** Every invocation with `--output-format json`
   returns a `session_id` field in its JSON output — including the one that starts `claude -p`
   without resuming. Save it the first time and reuse it on the next calls to the same hook to
   keep following that same conversation.
2. **From an interactive session you already have open.** The id is the filename
   `<sessionId>.jsonl` inside `~/.claude/projects/<your-encoded-project>/` (one folder per
   project, with dashes instead of `/`). You'll also see it in Claude Code's `/resume` picker.
3. **From a broker log.** Every invocation is recorded at
   `~/.agent-webhook-bridge/logs/<hook>-<timestamp>.log`, with Claude's full response — the
   `session_id` used is in there too.

Example of capturing the id on the first call and reusing it on the second (works the same
for either runner — the `SID` value just differs, a uuid for claude and a `.jsonl` path for
free-code):

```bash
# 1) first call: no sessionId, starts a brand-new session.
curl -s -X POST http://127.0.0.1:8890/hook/ci-failures \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <your secret>" \
  -d '{"log":"npm test exit 1"}'

# 2) read the session_id from that run's most recent log for the hook
SID=$(ls -t ~/.agent-webhook-bridge/logs/ci-failures-*.log | head -1 \
  | xargs cat | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)

# 3) second call to the same hook, now resuming that session
curl -s -X POST http://127.0.0.1:8890/hook/ci-failures \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <your secret>" \
  -H "sessionId: $SID" \
  -d '{"log":"same build still failing, second attempt"}'
```

For `--runner free-code` you can skip the log grep: the first call's callback body already
carries `session_id` as the `.jsonl` path (same as claude's callback does), so capture it there
if you're using `callbackUrl`.

## Result callback (`callbackUrl`)

`POST /hook/<name>` always answers `{"ok":true}` immediately — the agent run happens in the
background and its output only lands in the log file. If the caller needs the result back
(a job queue, an orchestrator like AgentMesh, a script that waits for the answer), include a
`callbackUrl` field in the JSON body of the event:

```bash
curl -X POST http://127.0.0.1:8890/hook/mesh-worker \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <secret>" \
  -d '{"jobId":"job-001","input":"Summarize this…","callbackUrl":"http://127.0.0.1:9000/jobs/job-001/result"}'
```

When the spawned run finishes, the broker POSTs the outcome to that URL as JSON:

```json
{"ok":true,"exitCode":0,"mode":"new","result":"…Claude's final answer…","session_id":"42e0b31f-…"}
```

- `result` and `session_id` are lifted from Claude's `--output-format json` envelope, so the
  caller can chain a follow-up request with the `sessionId` header without grepping logs.
- If the spawn itself fails, the callback body is `{"ok":false,"error":"…"}`; if the run exits
  non-zero, `ok` is `false` with the `exitCode`.
- Delivery is best-effort: one retry, 10s timeout per attempt, and a broker log entry either way.
  The log file in `~/.agent-webhook-bridge/logs/` remains the source of truth.
- **Only loopback URLs are accepted** (`http://127.0.0.1`, `http://localhost`, `http://[::1]`) —
  anything else is ignored with a warning, so a caller can't use the broker as a proxy to hit
  arbitrary hosts. When the consumer runs on another machine, put a local tunnel/relay in front,
  same as for inbound webhooks.
- Visible mode (`--visible`) captures no stdout (the output goes to the terminal via `tee`), so
  its callbacks carry `ok`/`exitCode` but no `result` — use hidden mode for automation loops.

## Permissions in headless mode

A spawned run has no terminal. What happens when the prompt asks the agent to write or edit a
file depends on the runner:

- **`--runner claude` (default):** Claude Code auto-denies Write/Edit/Bash when no one is there
  to approve the permission, and explains it couldn't do it. This happens even when resuming a
  session you've been using interactively without issues — the permission doesn't "carry over" to
  a new headless run.
- **`--runner free-code`:** free-code has no runtime auto-deny; instead the adapter scopes what
  the agent *can* attempt by choosing its `--tools` flag set from the hook's `--permission-mode`
  (see the table below). With the default (no `--permission-mode`) it runs read-only, so the agent
  literally has no Write/Edit/Bash tool to call — it answers from reading alone.

Real log from a claude hook without `--permission-mode` being asked to save a file:

```
"result": "I still don't have permission to write the file -- the system requires
someone to approve the write action from the interactive session ...",
"permission_denials": [{ "tool_name": "Write", "tool_input": { "file_path": "..." } }]
```

The fix is to declare `--permission-mode` when registering the hook:

```bash
awb rm resume
awb add resume --trigger \
  --workdir /home/lenovo/Documentos/free-code/free-code \
  --permission-mode acceptEdits
```

With that, the same request ends up actually writing the file:

```
"result": "Saved to `/home/lenovo/Documentos/free-code/free-code/resumen-sesion-flowise-webhook.md` (root of the working directory)."
```

| Mode | What it authorizes (claude) | free-code `--tools` it maps to |
|---|---|---|
| *(unset)* | Auto-denies Write/Edit/Bash — the agent answers but can't mutate. | `read,grep,find,ls` (read-only). The safe AgentMesh default. |
| `acceptEdits` | Auto-approves file **Write/Edit**. This is the one that fits most automation hooks — it doesn't enable anything else. | `read,edit,write,grep,find,ls` (no `bash`). |
| `bypassPermissions` | Skips **all** permission checks, including arbitrary `Bash`. Same risk as `--dangerously-skip-permissions`: only makes sense in an isolated sandbox, not on your machine with your real repos. | `read,bash,edit,write,grep,find,ls` (full, incl. `bash`). Same risk profile. |
| `dontAsk` | Tested and it does **not** authorize Write/Bash despite the name -- in a real headless run it still denied the write, same as leaving this unset. Don't rely on it to enable edits. | maps to the full set like `bypassPermissions` — for free-code, where there's no runtime prompt to answer, `dontAsk` means "don't gate it", so it's treated as full access. Same risk. |
| `auto` | Other `claude` mode, untested here; see `claude --help`. | maps to the full set like `bypassPermissions`. |
| `plan` / `manual` | Other `claude` modes that prompt; a spawned run has no TTY to confirm. | `read,grep,find,ls` (read-only) — there's no one to confirm a prompt. |

> **Opt-in on purpose, not a default:** `permissionMode` is **left unset by default** on a new
> hook — you have to ask for it explicitly. The reason: once a hook can write without asking,
> anyone who knows the hook's secret can make Claude write files in that `workdir` with whatever
> prompt they want. Only use it on hooks where you trust the event source and what the
> `--prompt-template` might end up asking Claude to do.

## Visible mode

By default a spawned run shows nothing -- the command runs hidden and all its stdout/stderr goes
straight to the log. With `--visible`, instead, a gnome-terminal window opens showing the exact
command and the response:

```bash
awb add resume --trigger \
  --workdir /home/lenovo/Documentos/free-code/free-code \
  --permission-mode acceptEdits \
  --visible
```

What shows up in the window:

```
$ claude --resume d63be319-433a-4ae1-8a1c-a8a978e53d89 -p '...' --output-format text --permission-mode acceptEdits
cwd: /home/lenovo/Documentos/free-code/free-code

Saved successfully to `/home/lenovo/Documentos/free-code/free-code/resumen-....md` ...

--- done (exit 0) -- press Enter to close ---
```

> **Non-obvious detail:** only `--output-format stream-json` streams token by token. `text`
> (like `json`) prints everything at once when the turn is done -- that's why the window sits
> blank while Claude works and dumps it all at the end. Without the `press Enter to close` pause,
> the window would close itself the instant it's done, before you'd have time to read it -- so
> visible mode always waits for your Enter before closing, unlike hidden mode.

That pause has a consequence: the event stays "in progress" in the broker until you close the
window. Since runs are serialized per `workdir` (see the option table in
[Registering a hook](#registering-a-hook)), if you leave the window open the next event for that
same `workdir` will queue up until you close it.

Only `gnome-terminal` is supported for now (Linux/GNOME). If it isn't installed, it falls back to
the usual hidden mode automatically without breaking the hook.

## Examples

### Simple trigger, with a shared secret

```bash
awb add ci-failures --trigger --workdir /home/lenovo/projects/my-repo \
  --prompt-template 'CI build failed:\n\n{{payload}}\n\nInvestigate the cause.'

curl -X POST http://127.0.0.1:8890/hook/ci-failures \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <secret from awb add>" \
  -d '{"branch":"main","step":"npm test","exitCode":1}'
```

### Queue, for a noisy source (without spawning Claude on every event)

A Flowise flow that fires often shouldn't spin up a Claude session for every single event —
with `--queue` the event is just persisted in SQLite (see [Current limitations](#current-limitations)
on how that queue is read today):

```bash
awb add flowise --queue --consumer queue

curl -X POST http://127.0.0.1:8890/hook/flowise \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <secret from awb add>" \
  -d '{"flow":"lead-scoring","result":"qualified","leadId":"8213"}'

awb events flowise   # confirm it got stored, status "pending"
```

### HMAC authentication instead of a shared secret

```bash
awb add deploys --trigger --hmac-secret 'a-long-random-secret' \
  --workdir /home/lenovo/projects/my-repo

BODY='{"env":"prod","status":"failed"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'a-long-random-secret' | sed 's/^.* //')

curl -X POST http://127.0.0.1:8890/hook/deploys \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=$SIG" \
  -d "$BODY"
```

This example skips `--prompt-template` on purpose, to show the fallback: the broker uses the
default template `"Incoming webhook event for '{{hook}}':\n\n{{payload}}"`. For a real use case
you'll almost always want your own `--prompt-template`.

> **Watch out with GitHub:** GitHub signs its webhooks with `X-Hub-Signature-256`, not
> `X-Signature`. If you want to point a GitHub webhook straight at this broker today, you need
> something in between to rename that header (or relay the event with a script) — there's no
> native support for GitHub's header name yet.

### Quick testing with `awb test` (no need to hand-build curl)

```bash
# brand-new session (no sessionId)
awb test ci-failures --body '{"log":"npm test exit 1"}'

# resumes an existing session (a claude uuid for --runner claude,
# a .jsonl path for --runner free-code)
awb test ci-failures --body '{"log":"npm test exit 1"}' \
  --session-id d63be319-433a-4ae1-8a1c-a8a978e53d89
```

The result of every invocation (exact command, the agent's stdout/stderr) is saved at
`~/.agent-webhook-bridge/logs/<hook>-<timestamp>.log`.

## Checking status

```bash
awb list             # registered hooks, mode, URL, secret
awb url ci-failures  # detail for one hook
awb events           # most recent events received and their status (pending/delivered/failed)
awb events ci-failures
```

## Security

- The server only listens on `127.0.0.1` — not exposed on the network by default.
- Authentication is mandatory per hook: a hook with neither `secret` nor `hmacSecret` configured
  never authenticates any request.
- For sources that don't run on the same machine (GitHub webhooks, Flowise on another host), put
  the broker behind a tunnel (`cloudflared`/`ngrok`) and prefer `hmacSecret` over a plain shared
  secret.
- Payloads are stored as-is in `events.db` — if the external source can include tokens or secrets
  in the body (CI logs, for example), keep that in mind before sharing that database.

## Current limitations

This is phase 1 of the roadmap (see [`PLAN.md`](PLAN.md)): broker + spawn adapter.

- `queue` mode persists events in SQLite, but there's no MCP adapter yet (`poll_events`/
  `wait_for_event`) to read them from a session — that's phase 2.
- Cursor and Codex CLI aren't supported yet in the spawn adapter — Claude Code and free-code only.
- There's no `systemd`/`launchd` unit or installer: `awb start` runs in the foreground and you
  have to supervise it yourself (or with `pm2`, `tmux`, etc.) if you want it to survive a reboot.

## free-code adapter

[free-code](https://github.com/EnmaSuamkf/free-code) is the second runtime the spawn adapter
knows how to wake. It's a full-featured coding agent with its own CLI (`free-code`), a
`-p`/`--print` headless mode, and a `--mode json` NDJSON event stream — the adapter turns that
stream into the same `{result, session_id}` envelope the claude adapter produces, so from the
broker/hub side the two are interchangeable.

Register a hook that spawns free-code instead of claude with `--runner free-code` (or
`--consumer spawn:free-code`):

```bash
awb add fc-worker --runner free-code \
  --workdir ~/agentmesh-sandbox \
  --prompt-template 'You are an AgentMesh agent. Incoming task:\n\n{{payload}}\n\nDo the task and answer with the final result.'
```

Everything else works the same: `--secret`/`--hmac-secret` for auth, `callbackUrl` in the body
to get the result back, `--visible` for a live terminal window. The only differences from a
`--runner claude` hook are:

- **Sessions resume by `.jsonl` path**, kept under `~/.agent-webhook-bridge/sessions/<hook>/`.
  The callback's `session_id` is that path; send it back as the `sessionId` header to continue.
  (See [New session vs. resuming](#new-session-vs-resuming-sessionid).)
- **`--permission-mode` is mapped to `--tools`**, not forwarded as a flag (free-code has no
  `--permission-mode`). See the table in [Permissions in headless mode](#permissions-in-headless-mode).
- The adapter passes `--no-extensions --no-skills --no-prompt-templates --no-themes --no-rag-server`
  so a sandbox workdir with untrusted job input can't make free-code discover and run code from
  local skills/extensions it finds there.

This is the runtime the AgentMesh concept paper had in mind for the single-operator bridge, and
it's what the demo agent in [`PLAN.md §4.3`](PLAN.md) maps to once you swap `--runner claude` for
`--runner free-code`.

## Command reference

| Command | What it does |
|---|---|
| `awb start` | Runs the broker in the foreground. |
| `awb add <name> [options]` | Registers a new hook (see [Registering a hook](#registering-a-hook)). `--runner <claude\|free-code>` picks which CLI a trigger hook spawns. |
| `awb rm <name>` | Removes a hook. |
| `awb list` | Lists all registered hooks. |
| `awb url <name>` | Shows the URL and auth header for a hook. |
| `awb events [name]` | Shows the most recently received events (and their status) from SQLite. |
| `awb test <name> [--body <json>] [--session-id <id>]` | Fires a real event against the running broker, with or without `sessionId` (a claude uuid or a free-code `.jsonl` path). |

---

Full styled, browsable guide: [`web-docs/index.html`](web-docs/index.html) · Roadmap and
architecture: [`PLAN.md`](PLAN.md)
