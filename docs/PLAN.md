# Consult Plan

Consult has evolved from a Claude Code plugin into a host-neutral delegation layer: a user starts work from one **Host** and delegates it to a configured ACP **Profile**. The current implementation has extracted that broker/profile/job model into **Consult Core** so multiple Host Adapters and direct CLI use can invoke the same delegation machinery.

See [`../CONTEXT.md`](../CONTEXT.md) for the domain vocabulary used throughout this document and the codebase.

## Goals

- Provide a portable **Consult Core** for profiles, brokers, jobs, state, permissions, setup, and result tracking.
- Support thin **Host Adapters** for environments such as Claude Code, Codex, and direct terminal use.
- Let any supported Host delegate to any configured ACP Profile.
- Multi-profile support — user can install several Profiles and pick per command or set defaults.
- Keep the proven broker daemon, IPC, and session-lifecycle shape while making
  it host-neutral and profile-aware.

## Non-goals (v1)

- Native structured review like Codex's `review/start`. ACP has no equivalent. Review proxy is **codex-only** in v1 (see [Review proxy](#review-proxy)); other backends return "not supported".
- The Codex stop-time review-gate hook. Add later if needed.
- Inline `session/request_permission` user prompts ("supervised" mode). Yolo or read-only, no middle ground.
- Forwarding Claude Code's MCP servers into delegated sessions. Each backend uses its own MCP config.
- Multiple profiles per backend type (e.g. two codex profiles with different defaults). One profile per backend for v1.
- Gemini CLI support. Excluded from v1 because it lacks `sessionCapabilities.resume` and `loadSession`, so `--resume` would always fail. Adding it would require either documenting the limitation per backend or building a different resume model.

## Host-neutral direction

Architectural decisions for this direction are recorded in `docs/adr/0003` through `docs/adr/0018`. The short version:

- **Consult Core** owns Profiles, Brokers, Jobs, state, permissions, setup, and the host-neutral CLI.
- A **Host Adapter** only maps a Host's native UX and lifecycle into Consult Core.
- **Host Identity** is `(host, hostSessionId)`. The `consult` CLI resolves it
  from explicit flags/env, known Host session environment variables, or
  `terminal/default`.
- Hosts without a real session id use a synthetic `default` Host Session, e.g. `terminal/default` or `codex/default`, unless overridden.
- Profiles are global to Consult, not scoped to a Host.
- Default Profile precedence is: explicit `--agent` / `--profile`, Workspace override, Host default, global default.
- Broker scope is one live Broker per active Job. Brokers self-terminate after
  their Job finalizes and remove their live state.
- Host Session identity scopes default resume lookup and best-effort lifecycle
  cleanup; it is not required for normal Broker cleanup.
- `consult brokers` lists live Broker locators and can clean stale/malformed
  Broker state.
- The default data root is `~/.consult`, with `CONSULT_DATA_DIR` still supported as an override.
- The host-neutral refactor is a clean break. It does not need to preserve old Claude-shaped state files or job records.
- Claude names belong only in the Claude Host Adapter; Consult Core state and env contracts use Host terminology.
- `review` remains a host-neutral CLI command, but support is
  Profile-capability-specific; in v1 it is codex-only.

## Implemented Components

- Claude Code uses plugin slash commands and a lifecycle hook. `SessionStart`
  writes `CONSULT_HOST=claude-code` and the current Host Session id into the
  Claude env file; `SessionEnd` performs best-effort cleanup for still-running
  Brokers for that Host Session.
- The single `consult` CLI resolves Host Identity from explicit Host flags,
  explicit `CONSULT_HOST` / `CONSULT_HOST_SESSION_ID` environment variables,
  known Host session variables (`OPENCODE_SESSION_ID`, `OPENCODE_RUN_ID`,
  `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`), or `terminal/default`.
- Consult does not ship Host-specific wrapper binaries. Host-specific command
  surfaces should call the same `consult` CLI or the same companion subcommands
  while keeping Host Adapters thin.
- Delegation Chains are implemented with `chainId`, `parentJobId`, and
  `delegationDepth` fields on Jobs.

Delegation Chain rules:

- A child Job records `chainId`, `parentJobId`, and `delegationDepth`.
- `chainId` is the root Job id.
- Default max depth should be small, likely 2.
- Child Jobs inherit Workspace, lineage, and permission ceiling.
- Child Jobs do not inherit Profile-specific model, effort, or resume settings.
- A child Job cannot be more permissive than its parent Job.
- Same-Profile child Jobs and self-delegation are allowed.
- Child Jobs are first-class Jobs visible in normal status.
- Cancelling a parent Job cancels active descendants.
- Child failure does not automatically fail the parent Job.
- `result <job-id>` returns the exact Job's output; chain rollups should be explicit.

## Directory Layout

Current layout:

```
consult/
├── CONTEXT.md                           # domain glossary
├── docs/
│   ├── PLAN.md                          # this file
│   ├── ROADMAP.md
│   └── adr/
│       ├── 0001-broker-per-profile-per-workspace.md
│       ├── 0002-per-profile-session-resume.md
│       ├── 0016-job-scoped-brokers.md
│       └── 0018-host-adapter-entrypoints-under-hosts.md
├── package.json                          # @agentclientprotocol/sdk dep
├── .claude-plugin -> hosts/claude-code/.claude-plugin
├── commands -> hosts/claude-code/commands
├── agents -> hosts/claude-code/agents
├── hooks -> hosts/claude-code/hooks
├── hosts/
│   └── claude-code/
│       ├── .claude-plugin/plugin.json   # Claude Code plugin manifest
│       ├── commands/                    # /consult:* slash commands
│       ├── agents/delegate.md           # consult:delegate subagent
│       ├── hooks/hooks.json             # Claude Code lifecycle hooks
│       └── scripts/
│           └── session-lifecycle-hook.mjs
├── scripts/
│   ├── consult-companion.mjs            # CLI entrypoint; every slash command shells here
│   ├── consult-broker.mjs               # broker daemon entrypoint (`serve` subcommand)
│   ├── registry.json                    # known backends catalog
│   └── lib/
│       ├── acp-client.mjs               # @agentclientprotocol/sdk wrapper
│       ├── broker-lifecycle.mjs         # spawn/discover/teardown/shutdown-rpc
│       ├── broker-endpoint.mjs          # Unix socket / TCP endpoint resolver
│       ├── broker-client.mjs            # companion-side socket client to the daemon
│       ├── permissions.mjs              # session/request_permission policy
│       ├── fs-handlers.mjs              # workspace-confined fs/read_text_file, fs/write_text_file
│       ├── profiles.mjs                 # global profiles file + per-workspace override
│       ├── state.mjs                    # atomic writes and data-root paths
│       ├── job-records.mjs              # persisted Job records and logs
│       ├── broker-job-runtime.mjs       # live Broker Job state
│       ├── delegation-chain.mjs         # parent/child Job lineage
│       ├── render.mjs                   # output formatting (tables, results)
│       ├── git.mjs                      # base ref, working tree helpers
│       ├── process.mjs                  # spawn/terminate process trees
│       ├── args.mjs                     # CLI parser
│       ├── path-safety.mjs              # realpath-confine helpers for fs handlers
│       └── workspace.mjs                # resolve git root
└── skills/
    └── consult-runtime/SKILL.md         # internal forwarding contract
```

## Command surface

Claude Code slash commands live under `hosts/claude-code/commands/`, with the root `commands/` symlink preserved as the Claude Code plugin entrypoint. Each command shells into `node scripts/consult-companion.mjs <subcommand>` with raw `$ARGUMENTS`. Markdown handles user-facing UX (Ask prompts, recommendations); the companion handles execution.

| Slash command | Companion subcommand | Notes |
|---|---|---|
| `/consult:setup` | `setup --json` | Two-phase: probe registry → menu with install / set-default actions. |
| `/consult:agents` | `agents [--set <name>]` | Lists profiles + status; can set default. |
| `/consult:delegate [args]` | `delegate ...` | Foreground/background, `--agent <name>`, `--write`, `--read-only` (default), `--resume`/`--resume-job <id>`/`--fresh`, `--parent-job <id>`, `--model`, `--effort`. |
| `/consult:review [args]` | `review ...` | Proxies to backend's `review` slash if advertised. |
| `/consult:status [id]` | `status ...` | Table of jobs; `--wait` blocks on one job. |
| `/consult:result [id]` | `result ...` | Final stored output for a job. |
| `/consult:cancel [id]` | `cancel ...` | `session/cancel` + SIGTERM on background worker. |
| `/consult:brokers [args]` | `brokers ...` | Inspect Broker locators; `--cleanup` removes stale/malformed locators, `--cleanup <job-id>` tears down one Broker. |

Internal subcommands (not user-facing): `task-worker` (background entrypoint), `task-resume-candidate` (resume-prompt helper).

## Setup / install flow

`/consult:setup` follows a strict install-verify-then-persist pattern. We never write a profile entry that we haven't proven works:

1. **Probe.** For each registry entry, check whether `<binary>` is on `PATH` (or already pinned in `profiles.json`). Build a status table.
2. **Menu.** `AskUserQuestion` with options: set-default (for installed-not-default profiles), install (for missing), done.
3. **Install (if chosen).** Run the registry's install command via `Bash` with `description: "Install <label>"`. Capture stdout, stderr, and exit code. **If exit code is non-zero, surface the captured output and abort without writing a profile entry.**
4. **Discover.** Re-probe `PATH` for the expected binary. If still not found (e.g. `npm install` succeeded but the binary landed somewhere the user's `PATH` doesn't include), surface the discovered install location and abort.
5. **Smoke probe.** Spawn the binary, run `initialize` with our minimal client capabilities, wait up to 5 s for the response. Abort and surface error if it fails (missing auth, version mismatch, crash on start).
6. **Persist.** Only now write the profile entry to `profiles.json`, including `lastVerifiedAt = now()`.
7. **Loop back to menu** so the user can install/configure more or exit.

The smoke probe step is the load-bearing check: it catches binaries that install successfully but can't actually run (uncommon but real, e.g. missing OS lib, expired auth).

## Registry

`scripts/registry.json` ships with four entries:

```jsonc
{
  "agents": [
    { "id": "codex", "label": "OpenAI Codex (ACP shim: codex-acp)",
      "binary": "codex-acp",
      "install": {
        "type": "github-release",
        "repo": "zed-industries/codex-acp",
        "version": "v0.14.0",
        "assetTemplate": "codex-acp-{versionNoV}-{target}.{ext}",
        "binaryInArchive": "codex-acp"
      },
      "advertisesReview": true,
      "supports": { "resume": true, "load": true } },
    { "id": "claude", "label": "Claude Agent (ACP shim: claude-agent-acp)",
      "binary": "claude-agent-acp",
      "install": { "type": "npm", "cmd": "npm install -g @zed-industries/claude-agent-acp" },
      "supports": { "resume": true, "load": true } },
    { "id": "opencode", "label": "OpenCode",
      "binary": "opencode", "args": ["acp"],
      "install": { "type": "npm", "cmd": "npm install -g opencode-ai" },
      "supports": { "resume": false, "load": true } },
    { "id": "copilot", "label": "GitHub Copilot CLI",
      "binary": "copilot", "args": ["--acp"],
      "install": { "type": "npm", "cmd": "npm install -g @github/copilot" },
      "supports": { "resume": false, "load": true } }
  ]
}
```

The `supports` block is documentation only — the actual capabilities come from each agent's `initialize` response at runtime. The `advertisesReview` flag is what `/consult:review` consults to decide whether to attempt a review proxy (see [Review proxy](#review-proxy)).

### Install types

`install.type` selects the installer in `setup-install.mjs`:

- **`cargo`** / **`npm`** — `install.cmd` is shelled out via `sh -lc`, then the registry's `binary` is located on `PATH`. Failure modes: install-stage non-zero exit, discover-stage binary not on PATH.
- **`github-release`** — downloads a prebuilt asset from GitHub releases, extracts it to `<dataDir>/bin/<registryId>/`, and uses the absolute path of `binaryInArchive` (or `binary` if omitted) for the profile entry. Required fields: `repo`, `version`, `assetTemplate`. The template supports `{version}`, `{versionNoV}`, `{target}` (rust-style triple, e.g. `x86_64-unknown-linux-gnu`), and `{ext}` (`tar.gz` on unix, `zip` on windows). Bundled companion files in the archive (e.g. codex-acp's `codex-resources/bwrap`) travel with the binary because we extract the whole archive into the per-registry-id install root. **SHA-256 digest is required** — the installer fetches release metadata from `api.github.com/repos/{repo}/releases/tags/{version}`, reads the matching asset's `digest` field, and verifies the downloaded tarball before extraction. An asset without a digest aborts the install with an explicit "refusing to install unverified binary" error rather than degrading to TLS-only trust.

Backends explicitly **deferred to a later release**:
- Gemini CLI — lacks both `sessionCapabilities.resume` and `loadSession`, breaks the `--resume` UX uniformly.
- All other ACP-speaking agents (Cursor, Goose, Kimi, Qwen, Augment, Aider wrappers, etc.) — can be added once we have a conformance test harness.

## State layout

Broker state is scoped per live **Job**. Host, Host Session, Profile, and Workspace stay on the Job and Broker metadata for ownership, resume lookup, and best-effort lifecycle cleanup.

```
~/.consult/
├── profiles.json                                                # global config — see "Profiles schema" below
└── workspaces/
    └── <sha256-of-repo-root>/
        ├── jobs/<job-id>.json                                   # full job record (status, host, hostSessionId, sessionId, profile, finalText, ...)
        ├── logs/<job-id>.log                                    # NDJSON of all session/update notifications
        ├── brokers/<job-id>.json                                # live daemon endpoint + pidfile; removed on normal finalization
        └── override.json                                        # per-workspace default profile override (optional)
```

### Profiles schema

`profiles.json` is the single global config file for the plugin. Version-tagged so we can migrate later.

```jsonc
{
  "schemaVersion": 1,
  "default": "codex",                              // null if no profile is set
  "hostDefaults": { "codex": "claude" },           // optional Host-specific defaults
  "profiles": {
    "codex": {
      "registryId": "codex",                       // matches an entry in registry.json
      "binary": "/absolute/path/to/codex-acp",     // resolved at install time
      "args": [],                                  // extra argv to pass on spawn
      "env": {},                                   // extra env vars
      "installedAt": "2026-05-14T17:30:00Z",
      "installedVia": "registry",                  // "registry" | "manual"
      "lastVerifiedAt": "2026-05-14T17:30:05Z"     // when we last ran initialize() against it
    }
  }
}
```

Required keys per profile: `registryId`, `binary`, `args`, `env`, `installedAt`. `lastVerifiedAt` is updated whenever a broker successfully completes its initialize handshake against this profile. `profiles.mjs` validates the schema on load and rejects malformed files with a clear error rather than silently using a partial structure.

`override.json` per workspace is one line: `{ "profile": "claude" }`. Validated against the global profile list — pinning to a non-existent profile errors out.

The Claude Host Adapter's `SessionStart` hook injects `CONSULT_HOST=claude-code` and `CONSULT_HOST_SESSION_ID=<session>` into the env file; every companion invocation reads Host Identity through the shared resolver. `SessionEnd` enumerates broker state files, reads their Host Identity, and tears down only brokers for `claude-code/<this-session-id>`. Brokers for other Host sessions in the same repo are untouched.

**Atomic writes.** Every JSON write under `workspaces/<hash>/` goes through `state.mjs#atomicWriteJson`, which:

1. Creates the temp file **in the same directory** as the destination (so the rename target is on the same filesystem).
2. Writes the bytes, `fsync`s the file.
3. `fs.rename`s into place.
4. `fsync`s the parent directory (where supported on the platform) to durably commit the rename.
5. Throws on `EXDEV` rather than falling back to copy+unlink — cross-device rename is a configuration bug, not something to paper over.

A unit test fakes a cross-device rename by symlinking the data dir onto `/tmp`; `atomicWriteJson` must throw, not silently degrade.

**No `jobs.json` index file.** The codex plugin keeps an index; we don't. Listing jobs reads the `jobs/` directory and sorts by mtime. Removes the multi-writer race on a single index file; trades it for slightly slower `status --all` listings (acceptable — typical N is &lt; 50).

**No separate `sessions/<profile>.json` pointer.** Resume candidates are derived from finalized job records, not from a separately-mutable pointer. `--resume` does: scan `jobs/`, filter to the current `{host, hostSessionId, profile, status: "completed" | "failed"}`, sort by `completedAt`, pick the most recent's `sessionId`. `--resume-job <job-id>` is the explicit cross-Host-Session selector, but the selected Profile must match the target Job's Profile. The pointer-update race goes away.

## Connection lifecycle (per command)

The broker is a separate daemon process per active Job, reachable via a Unix-domain socket keyed by `jobId`. The companion CLI is short-lived; it connects to the daemon for the Job command and sends RPC over the socket.

1. Resolve workspace root, selected profile, and Host Identity (CLI flags,
   explicit Consult env vars, known Host session env vars, or
   `terminal/default`).
2. **Get-or-spawn broker** (`broker-lifecycle.mjs#ensureBrokerSession`): read the Job-scoped broker state file; ping endpoint for 150 ms; if alive, reuse for that same Job; if absent or unreachable, clean up stale files, then spawn `node consult-broker.mjs serve --endpoint <socket> --cwd <ws> --profile <id> --job-id <job-id> --registry-id <registry-id> --host <host> --host-session-id <id> --pid-file <path>` detached. Wait up to 2 s for the endpoint to listen.
3. The daemon (`consult-broker.mjs`) is what actually owns the ACP agent child and the `ClientSideConnection` from `@agentclientprotocol/sdk`. It sends `initialize` once on startup and caches capabilities. It listens on the Unix socket and routes each client's RPC into the agent.
4. Companion connects to the socket; sends a `consult/run` RPC envelope (see [Companion ↔ daemon RPC envelope](#companion--daemon-rpc-envelope) below).
5. The daemon either calls `session/new` (with workspace `cwd`, empty `mcpServers`) or `session/resume` / `session/load` for resume, then `session/prompt`. It pipes `session/update` notifications back to the companion over the socket as JSON-RPC notifications.
6. Companion writes notifications to the job's NDJSON log file and updates the structured job record in real time. On stop reason, it finalizes the job and exits.
7. After the final job record is persisted and subscribers are notified, the daemon disposes the backend process, removes its broker state/socket/pid files, and exits. Host lifecycle hooks remain best-effort cleanup for still-running Jobs.

For `--resume`:
- If the fresh daemon's agent has `sessionCapabilities.resume` AND we have a candidate sessionId → `session/resume` (fast, no replay).
- Else if agent has `loadSession` → `session/load` (history replay).
- Else fail with: *"Backend `<name>` cannot resume. Rerun with `--fresh` or pick a backend that supports resume."*

### Companion ↔ daemon RPC envelope

The protocol on the Unix socket is line-delimited JSON-RPC with a small `consult/*` method namespace on top of forwarded ACP calls.

Control plane (always allowed, even when a prompt is mid-flight):
- `consult/ping` — health check.
- `consult/cancel { jobId }` — daemon sends `session/cancel` for that job's session, then forwards completion.
- `broker/shutdown` — graceful daemon termination.

Work plane (one in-flight at a time per daemon — the `BROKER_BUSY` mutex inherited from codex):
- `consult/run { jobId, kind: "delegate"|"review", mode: "write"|"read-only", profile, resume: sessionId|null, prompt, baseRef? }` — daemon picks the right ACP method sequence, returns `{accepted: true}` immediately, then streams `session/update` notifications and finally a `consult/finalized { jobId, stopReason, sessionId, touchedFiles }` notification.
- `consult/attach { jobId }` — reattaches to an active job (see idempotency below).

The control-plane methods bypass the `BROKER_BUSY` mutex. This is the codex pattern — codex broker special-cases `turn/interrupt` while a stream is active (`allowInterruptDuringActiveStream` in `app-server-broker.mjs` lines 170–184). We do the same for `consult/cancel` and `broker/shutdown`. Without this, `/consult:cancel` would queue behind the prompt it's trying to interrupt.

### `consult/run` idempotency and retry

`jobId` is the idempotency key. The daemon keeps an in-memory map `activeJobs: Map<jobId, JobState>`, while the live broker locator is stored under `brokers/<job-id>.json` and durable history stays in `jobs/<job-id>.json`.

| Companion request | Daemon behavior |
|---|---|
| `consult/run` with new `jobId` | Accept, start work. |
| `consult/run` with `jobId` already running, **same payload hash** | Treat as reattach: re-stream pending notifications buffered since acceptance; no duplicate prompt. |
| `consult/run` with `jobId` already running, **different payload hash** | Reject with `JOB_CONFLICT` error; companion picks a new jobId. |
| `consult/run` with `jobId` already finalized | Reject with `JOB_FINALIZED`; companion calls `result` instead. |
| `consult/attach { jobId }` | Reattach without sending any new prompt (used by live recovery flows). |

The daemon buffers a sliding window of recent `session/update` notifications (last 500 per job) so a reattaching companion can catch up. Older notifications stay in the NDJSON log on disk — reattach is for "I lost the socket two seconds ago," not for recovering hour-old state.

### Companion disconnect during in-flight prompt

If the companion socket closes after the daemon accepted a `consult/run` but before `consult/finalized`:

1. Daemon's `socket.on("close")` handler checks whether the socket owns the active job.
2. If yes, daemon sends ACP `session/cancel` for that session and starts a **2-second timer** for the agent's acknowledgement.
3. **If the agent acknowledges within 2 s:** clean shutdown — daemon writes a `cancelled` job record (gated on detecting companion didn't finalize), notifies subscribers, and exits.
4. **If the timer expires:** daemon (a) writes a `failed` job record with `errorMessage: "agent did not acknowledge cancel"`, (b) marks the broker tainted, (c) notifies subscribers, and (d) exits through the terminal-job shutdown path.

This closes the "companion dies mid-prompt → stale running job + agent burning compute with no listener" gap that codex's broker has, and bounds the worst case at 2 s of `BROKER_BUSY` hold time.

## Permission policy

Two layers: ACP `session/request_permission` for agent-initiated tool calls, and direct `fs/*` handlers we implement client-side. Both layers are workspace-confined; that's a universal hygiene rule, not a mode-dependent one.

### `session/request_permission` (in `permissions.mjs`)

| `kind` | `--write` | `--read-only` (default) |
|---|---|---|
| `read`, `search`, `think` | ✅ allow (path-confined) | ✅ allow (path-confined) |
| `fetch` | ❌ deny (exfil vector) | ❌ deny (exfil vector) |
| `edit`, `delete`, `move` | ✅ allow (path-confined) | ❌ deny |
| `execute` | ❌ deny | ❌ deny |
| `switch_mode`, `other` | ✅ allow | ❌ deny |

**Path/cwd confinement for backend-native tool calls.** Approval for `read`, `search`, `edit`, `delete`, `move`, `execute` is conditional on the request payload's paths/cwd resolving inside the workspace via `path-safety.mjs`. If the agent asks to read `/etc/passwd` or to execute `bash` with `cwd: /tmp`, we deny it even in `--write` mode. The same realpath-confine logic that protects `fs/*` handlers applies to permission requests carrying paths or cwd — without it, the fs sandbox is illusory because the agent can route around it via `kind: read` permission grants.

`fetch` is denied in both modes because combined with workspace reads it is a
clean read-then-exfiltrate path. `execute` is also denied in both modes because
ACP execute requests expose a raw command string that Consult cannot safely
constrain by cwd inspection alone.

No mid-task user prompts. The decision is made at command start.

### `fs/read_text_file` and `fs/write_text_file` (in `fs-handlers.mjs`)

These are ACP client methods — the agent calls *us* to read/write files. We implement them with a hard workspace boundary (see `path-safety.mjs`):

1. `fs.realpath` the requested path. If it doesn't exist yet (write case), realpath the *parent* directory and re-append the basename.
2. Reject if the realpath does not start with `<workspaceRoot>/`. This blocks symlink escapes — even a symlink inside the workspace pointing at `/etc/passwd` is rejected because the realpath leaves the tree.
3. For writes, additionally check the mode flag — `fs/write_text_file` returns an ACP error if `--read-only` was passed.

Reads of well-known sensitive files inside the workspace (`.env`, `.git/`, `id_rsa`, etc.) are NOT blocked in v1 — the workspace is the user's own repo, and over-blocking trips legitimate uses (reading `.env.example` to write code). Users who care can run `--read-only` and inspect first.

### Opt-in process sandbox

Set `CONSULT_AGENT_SANDBOX=bwrap` to make the Broker launch the ACP agent
through bubblewrap. In that mode, the agent gets a fresh filesystem namespace:

1. `--read-only` jobs bind the Workspace read-only.
2. `--write` jobs bind the Workspace read-write.
3. Standard runtime paths needed to execute the agent are mounted read-only,
   `$HOME` points at `/tmp` inside the namespace, and proven profile-specific
   auth/config directories can be mounted read-only into that sandbox home
   (`claude`: host `~/.claude` -> `/tmp/.claude`).
4. If the next job needs a different sandbox write mode, the Broker restarts the
   agent before opening the session.

The default remains off while real-backend auth/config mounts are proven across
profiles.

## Background execution

Background execution uses the same high-level worker pattern as the original
single-backend plugin, with job-scoped Broker routing:

1. `delegate --background` writes a "queued" job record, spawns a detached `node consult-companion.mjs task-worker --job-id <id>` subprocess with `stdio: "ignore"`, returns to caller.
2. The worker reads the job's request, calls into the same connection-lifecycle code, streams updates to the job's NDJSON log, finalizes the record on completion.
3. `/consult:status <id>` reads the job file to report progress.
4. `/consult:cancel <id>` connects to the Job's live Broker, sends ACP's `session/cancel` notification, and `SIGTERM`s the worker process tree (via `process.mjs`). If the Broker is gone while the Job record still says running, cancel treats the Job as orphaned and marks it failed.

## Review proxy

`/consult:review` is **codex-only in v1**. Per-backend adapter approach: we only invoke a backend's review slash command when we have a tested adapter for it. Codex-acp has a well-defined `/review` slash with documented `--base` semantics that we've verified; that's the only one shipping in v1.

For the codex adapter (`adapters/codex-review.mjs`):

1. Resolve the review target deterministically *on our side* (using `git.mjs`): working-tree mode produces `git diff` + `git status` output; `--base ref` mode produces `git diff <ref>...HEAD`. We generate the diff text ourselves rather than trusting the backend to interpret `--base`.
2. Connect to the codex broker, call `session/new`.
3. Wait up to 2 s for `available_commands_update`. If `review` isn't listed (codex-acp doesn't advertise it for some reason), fail clearly.
4. Send `session/prompt` with a message that includes the pre-resolved diff in a content block, plus the slash invocation. The backend reviews what we showed it, not whatever it would have resolved from `--base`.
5. Stream `session/update`, finalize the job.

For all other backends (`claude`, `opencode`, `copilot` in v1): `/consult:review` exits with:
> *"`/consult:review` is codex-only in v1. Use `/consult:delegate --agent <name>` with a review-style prompt, or switch to `--agent codex`."*

Future: add per-backend adapters in `adapters/` as we verify their review surfaces.

## Subagent

`hosts/claude-code/agents/delegate.md` defines a `consult:delegate` subagent,
with the root `agents/` symlink preserved as the Claude Code plugin entrypoint.
It is a thin forwarder used by the main Claude Code thread when it wants to hand
a chunky task to another agent. Single Bash call into
`node scripts/consult-companion.mjs delegate ...`, returns stdout verbatim, no
commentary.

## Hooks

`hosts/claude-code/hooks/hooks.json` registers a session-lifecycle hook that
invokes `hosts/claude-code/scripts/session-lifecycle-hook.mjs`:

- On `SessionStart`: writes `CONSULT_HOST=claude-code` and `CONSULT_HOST_SESSION_ID=<session>` into `$CLAUDE_ENV_FILE`. Every subsequent companion invocation reads this through the shared Host identity resolver.
- On `SessionEnd`: enumerates `workspaces/<hash>/brokers/*.json`, reads each broker's stored Host Identity, and tears down only still-running brokers for `claude-code/<this-session-id>`. Brokers belonging to other Host sessions in the same workspace are never touched.

Host Session scoping is primarily a resume/grouping identity. Job-scoped
Brokers do not rely on Host lifecycle hooks for normal cleanup. ADR-0016
records the shipped job-scoped Broker design and supersedes the older warm
Broker ADRs.

Skipped for v1: the optional stop-time review-gate hook.

## Removed single-backend assumptions

- `review/start` proprietary endpoint and structured review schema (no ACP equivalent).
- `gpt-5-4-prompting` skill — Codex-specific.
- `spark` model alias, fixed Codex effort levels (passthrough generic `--model`/`--effort`).
- Stop-review-gate hook and `stop-review-gate.md` prompt template.
- `codex-result-handling` skill — replaced by simpler render logic.

## Open risks

- ACP's TypeScript SDK (`@agentclientprotocol/sdk`) version stability — protocol is young (~1 year), breaking changes possible. Pin to a specific version in `package.json` and treat upgrades as a tracked task.
- `available_commands_update` is fire-and-forget; codex-acp may delay it past our 2-second wait, causing the codex review adapter to false-negative. Make the timeout overridable via env var; bump if we see false negatives in smoke tests.
- Broker crash recovery — stale broker detection, teardown/respawn on next use,
  cancel-time unreachable handling, tainting after unacknowledged disconnect
  cancels, and foreground `BROKER_DISCONNECTED` failure after broker disconnect
  are enough for v1. If the agent process crashes mid-job, the user may still
  see a generic ACP transport error; polish that further only if it shows up as
  a real usability problem.
- `BROKER_BUSY` remains the expected same-Broker behavior, but Brokers are now
  job-scoped. Two different Jobs in the same Host Session/Profile/Workspace can
  run concurrently in separate Brokers.
