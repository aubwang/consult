# Consult Architecture Plan

Consult is a CLI-first, host-neutral delegation layer. A Host invokes the
single `consult` command, which creates a durable Job and delegates exactly one
prompt turn to a configured ACP Profile.

See [`../CONTEXT.md`](../CONTEXT.md) for the normative domain language and
[`adr/`](adr/) for accepted decisions.

## Product Boundaries

- Consult Core owns Profile setup, Host Identity, Jobs, Broker/inline ACP
  transport, permissions, artifacts, resume, cancellation, and lineage.
- The public surface is the `consult` CLI plus optional agent skills that call
  that CLI.
- Shipped Host autodetection covers terminal, Codex, and opencode. Explicit
  `CONSULT_HOST` values support custom Hosts without a Host-specific adapter.
- The built-in Profile registry contains `claude`, `codex`, and `opencode`.
- Claude is a delegated Profile, not a shipped Host plugin. Gemini and Copilot
  are not supported Profiles.
- Cruise owns Cruise workflow policy and session state; Consult supplies only
  delegation mechanisms.

## Goals

- Give agents a small, durable interface for cold, self-contained delegation.
- Keep every Job observable and cancellable regardless of Profile.
- Preserve one stable Job result contract across foreground, background,
  review, in-place, and isolated execution.
- Prefer portable ACP and Git behavior; use Profile-native capabilities only as
  internal optimizations with a portable fallback.
- Make read-only the default and require explicit authority for writes and
  execution.
- Avoid modifying the user's active checkout for delegated implementation work
  when `--isolated` is requested.

## Non-Goals

- Cross-Profile native conversation transfer.
- A permanent agent app server or a dependency on Codex app-server APIs.
- Forwarding one Host's private MCP configuration to a Profile.
- Interactive permission prompting during a Job.
- Hard process isolation on platforms without the configured sandbox.
- Multiple separately named installations of one built-in Profile type.

## Repository Layout

```text
consult/
├── bin/consult                         # stable JS executable
├── scripts/consult-companion.mts       # CLI dispatch and public help
├── scripts/consult-broker.mts          # background Job ACP process
├── scripts/registry.json               # built-in Profile catalog
├── scripts/lib/
│   ├── companion/                      # command implementations
│   ├── inline-turn-runner.mts          # foreground/isolated inline transport
│   ├── broker-job-runtime.mts           # shared Job/session runtime
│   ├── job-agent.mts                    # shared ACP agent wiring
│   ├── job-records.mts                  # mutable internal records
│   ├── job-result-contract.mts          # stable public JSON envelope
│   ├── isolated-workspace.mts           # transactional Git worktrees
│   ├── permissions.mts                  # ACP permission decisions
│   └── process-sandbox.mts              # optional bubblewrap launch
├── skills/                              # CLI-calling agent skills
├── docs/conformance/                    # Profile probe records
└── docs/adr/                            # accepted decisions
```

When run from a checkout, `bin/consult` loads erasable `.mts` source through
Node 24 native type stripping. Installed packages load compiled `.mjs` from
`dist/`; Node intentionally refuses to strip TypeScript in `node_modules`.
Bun remains the repository package manager and lockfile owner.

## Host Identity and Profile Selection

Host Identity resolution order:

1. `--host` / `--host-session` CLI flags.
2. `CONSULT_HOST` / `CONSULT_HOST_SESSION_ID`.
3. `CODEX_THREAD_ID`, or `OPENCODE_SESSION_ID` / `OPENCODE_RUN_ID`.
4. `terminal/default`.

Profile selection order:

1. Explicit `--agent` / `--profile`.
2. Workspace override.
3. Host default.
4. Global default.

Profile configuration is global to Consult, not tied to the Host. A Job may
target a Profile associated with the same product as its Host.

## Jobs and Public Results

A Job is the durable record for one prompt turn. Lifecycle:

```text
queued -> running -> completed | cancelled | failed
```

Mutable records may gain internal fields as implementation needs change.
Machine-readable commands expose an allow-listed versioned contract instead:

```jsonc
{
  "schemaVersion": 1,
  "job": {
    "id": "job-...",
    "kind": "delegate",
    "status": "completed",
    "profile": "claude",
    "mode": "read-only"
  },
  "outcome": {
    "stopReason": "end_turn",
    "sessionId": "...",
    "errorMessage": null,
    "finalText": "agent-authored message text"
  },
  "artifacts": {
    "touchedFiles": [],
    "logPath": "...",
    "patchPath": null,
    "touchedFilesPath": null
  },
  "lineage": {
    "chainId": null,
    "parentJobId": null,
    "childJobIds": [],
    "delegationDepth": 0
  }
}
```

Tool-call renderings remain in logs and live progress. `finalText` accumulates
only Profile agent-message text so scripts do not mistake tool markers for the
answer.

## State Layout

```text
~/.consult/
├── profiles.json
└── workspaces/<sha256-of-canonical-git-root>/
    ├── jobs/<job-id>.json
    ├── logs/<job-id>.log
    ├── brokers/<job-id>.json
    ├── isolated-jobs/<job-id>/
    │   ├── worktree/                    # temporary; removed at cleanup
    │   └── artifacts/
    │       ├── changes.patch
    │       ├── touched-files.json
    │       └── cleanup.json
    └── override.json
```

The canonical Git root is always the Workspace identity. An isolated detached
worktree is only the Profile's Execution Workspace; records, logs, lineage,
Profile selection, and resume lookup stay under the original Workspace.

JSON state updates use same-directory temp files, file and directory fsync,
and atomic rename. There is no shared `jobs.json` index: listing scans
individual records to avoid a multi-writer index race.

## Foreground and Background Execution

Foreground `delegate` runs the ACP agent inline in the companion process. The
inline path uses the same Job runtime, agent wiring, permission handler,
session controls, logs, and finalization contract as the Broker path.

Normal background Jobs use one detached Broker per active Job:

1. The companion writes a queued record and starts a detached worker.
2. The worker obtains or starts the Job-scoped Broker.
3. The Broker starts the Profile's ACP executable and performs `initialize`.
4. The worker submits `consult/run`; the Broker opens/resumes a Session and
   starts one prompt turn.
5. Updates stream into the log and Job record.
6. The Job finalizes, the Profile process is disposed, and Broker live state is
   removed.

Isolated background Jobs may run the shared runtime inline inside their already
detached worker. This keeps original Workspace state separate from the
Execution Workspace without creating a second daemon contract. The worker pid
is recorded as the inline runner so `consult cancel` can signal it safely.

The external Job behavior is identical across transports. `jobId` is the
idempotency key for Broker requests; replay with a different payload is a
conflict. Payload identity includes permission-relevant execution opt-ins.

## Sessions and Resume

`--resume` searches finalized delegate Jobs for the current Workspace, Host
Session, and Profile. `--resume-job <id>` selects an explicit compatible Job.
The new transport then uses:

1. ACP `session/resume` when advertised.
2. ACP `session/load` when resume is absent but load is advertised.
3. A clear `RESUME_UNSUPPORTED` failure otherwise.

Resume stays within one Profile. A different Profile receives a self-contained
new prompt rather than an attempted native session conversion.

## Pinned Diff and Review

`delegate --include-diff [--base <ref>]` resolves the review material before
the Job is created:

- Base references are resolved safely to commits.
- Working-tree capture includes staged and unstaged tracked changes and lists
  untracked paths.
- Unborn repositories are handled.
- Diff text is UTF-8-safe, bounded, and explicitly delimited as untrusted data.
- Background Jobs persist the augmented prompt used by their worker.

`review` is Profile-neutral. Consult always resolves a pinned diff and creates
a read-only, findings-first review Job. The verified Codex native review
command remains an adapter optimization; Claude and opencode use ordinary ACP
delegation against the same deterministic input.

## Transactional Isolated Writes

`delegate --write --isolated` implements this transaction:

1. Resolve the Workspace and allocate a Job id.
2. Create a Consult-owned detached worktree at `HEAD`.
3. Reconstruct staged and unstaged tracked changes with binary Git patches.
4. Copy safe, nonignored, regular untracked files. Reject symlinks, traversal,
   invalid path encodings, and special files.
5. Snapshot that seeded tree as the baseline.
6. Run the Profile with the worktree as cwd while Job state stays rooted at the
   original Workspace.
7. Snapshot the final tree and write an agent-only binary patch relative to the
   seeded baseline plus a touched-files manifest.
8. Persist artifact metadata and remove the worktree in a `finally` cleanup.

The patch represents only the delegate's delta, not the user's pre-existing
dirty state. Artifacts remain after worktree cleanup. Applying a patch to the
active checkout is intentionally a separate, user-controlled operation.
Gitignored files are neither seeded nor captured, including ignored files the
Profile creates, and the repository must have at least one commit to supply the
detached-worktree base.

In-place `--write` remains for compatibility. `--isolated` requires
`--write`; the flag is explicit while the behavior gains field experience.

## Permission and Sandbox Policy

ACP file handlers and permission-bearing paths are realpath-confined to the
Execution Workspace and reject symlink escapes.

| Request kind | Read-only | In-place write | Isolated write | `--allow-exec` requested |
| --- | --- | --- | --- | --- |
| read/search/think | allow, path-confined | allow, path-confined | allow, path-confined | allow, path-confined |
| edit/delete/move | deny | allow, path-confined | allow, path-confined | allow, path-confined |
| fetch | deny | deny | deny | deny |
| execute | deny | deny | deny | deny; preflight rejects the Job |
| switch_mode/other | deny | allow | allow | allow |

Execute authority remains represented in the internal `consult/run` payload and
its idempotency hash for compatibility, but `delegate --allow-exec` fails
preflight and the shared permission handler denies it defensively. The current
bubblewrap backend is a filesystem boundary only; it shares host networking and
cannot safely grant arbitrary execution.

Bubblewrap binds the Execution Workspace according to mode and mounts only the
runtime and proven Profile auth/config paths needed to launch the ACP agent.
It is a filesystem sandbox; the agent needs network access to contact its model
API. Some Profiles perform edits without first asking ACP permission, so
non-bwrap confinement and isolated transactions are defense-in-depth rather
than a hard process boundary.

## Delegation Chains

Nested delegation uses `chainId`, `parentJobId`, and `delegationDepth`.
`CONSULT_PARENT_JOB` is injected into delegated environments, while an explicit
`--parent-job` wins. A child inherits Workspace, lineage, and a permission
ceiling but not model, effort, or resume choices. Default maximum depth is two.
Cancelling a parent cancels active descendants; child failure does not
automatically fail the parent.

## Packaging and Verification

Development uses Bun for package installation and scripts, while production
execution uses Node 24 or newer:

```sh
bun run typecheck
bun run test
bun run pack:check
```

`bun run test` intentionally executes `node --test`; `bun test` is not the
project test command. `pack:check` builds the published `.mjs`, packs the npm
tarball, installs it globally with npm and Bun in temporary prefixes, verifies
the package file allow-list, runs `consult help` from both installs, and proves
an npm-installed background worker and Broker launch their compiled `.mjs`
entrypoints and finalize a Job.

Behavior and architecture changes update this document and, when they make or
supersede a durable decision, add an ADR.
