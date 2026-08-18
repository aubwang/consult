# Consult Architecture Plan

Consult is a CLI-first, host-neutral delegation layer. A Host invokes the
single `consult` command, which creates a durable Job and delegates exactly one
prompt turn to a configured ACP Profile.

See [`../CONTEXT.md`](../CONTEXT.md) for the normative domain language and
[`adr/`](adr/) for accepted decisions.

## Product Boundaries

- Consult Core owns Profile setup, Host Identity, Jobs, Broker/inline ACP
  transport, permissions, artifacts, resume, cancellation, and lineage.
- The public surface is the `consult` CLI and nothing else. Delegation
  judgment ships as `consult help` topics inside the binary, not as agent
  skills, plugins, or Host adapters.
- Shipped Host autodetection covers terminal, Codex, and opencode. Explicit
  `CONSULT_HOST` values support custom Hosts without a Host-specific adapter.
- The built-in Profile registry contains `claude`, `codex`, `opencode`, and
  `copilot`.
- Claude is a delegated Profile, not a shipped Host plugin. GitHub Copilot is
  a delegated inherit-only preview Profile (ADR-0038); its model-turn
  conformance is still auth-deferred. Gemini is not a supported Profile.
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
- Host-specific prompt injection or wake-up APIs. Portable waiting remains a
  normal blocking CLI operation, interim Job events are recorded portably
  (`consult report` / `consult events`, ADR-0039), and mid-Job guidance is
  delivered portably through the Job's own Broker (`consult steer`, ADR-0040) —
  none of it delivering, pushing, or waking anything Host-side.
- Forwarding one Host's private MCP configuration to a Profile.
- Interactive permission prompting during a Job.
- Native Windows or macOS x64 process support, or an ambient-authority fallback
  presented as a security boundary.
- Multiple separately named installations of one built-in Profile type.

## Repository Layout

```text
consult/
├── bin/consult                         # stable JS executable
├── scripts/consult-companion.mts       # CLI dispatch
├── scripts/consult-broker.mts          # background Job ACP process
├── scripts/registry.json               # built-in Profile catalog
├── scripts/lib/
│   ├── companion/                      # command implementations
│   ├── companion/help.mts              # overview and progressive topics
│   ├── companion/command-help.mts      # per-command usage
│   ├── inline-turn-runner.mts          # foreground/isolated inline transport
│   ├── broker-job-runtime.mts           # shared Job/session runtime
│   ├── job-agent.mts                    # shared ACP agent wiring
│   ├── job-records.mts                  # mutable internal records
│   ├── job-result-contract.mts          # stable public JSON envelope
│   ├── isolated-workspace.mts           # transactional Git worktrees
│   ├── job-authority.mts                # canonical portable authority model
│   ├── job-authority-preflight.mts      # fail-closed combination gate
│   ├── permissions.mts                  # ACP permission decisions
│   ├── egress-proxy.mts                 # authenticated pinned-address proxy + accounting
│   ├── sandbox-runtime-launch.mts       # native confined Profile launch
│   └── sandbox-runtime-policy.mts       # pinned generated-policy transform
├── docs/conformance/                    # Profile probe records
└── docs/adr/                            # accepted decisions
```

When run from a checkout, `bin/consult` loads erasable `.mts` source through
Node native type stripping. Installed packages load compiled `.mjs` from
`dist/`; Node intentionally refuses to strip TypeScript in `node_modules`.
Bun remains the repository package manager and lockfile owner.

## Host Identity and Profile Selection

Host Identity resolution order:

1. `--host` / `--host-session` CLI flags.
2. `CONSULT_HOST` / `CONSULT_HOST_SESSION_ID`.
3. `CODEX_THREAD_ID`, or `OPENCODE_SESSION_ID` / `OPENCODE_RUN_ID`.
4. `terminal/default`.

Claude Code is deliberately not auto-detected after the CLI-only product-scope
decision. A Claude spawning Host must supply explicit Host and Host Session
identity (flags or `CONSULT_*` environment) when it needs isolated defaults and
resume lookup; otherwise it shares `terminal/default`.

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
queued -> running -> completed | cancelled | failed | skipped
```

Mutable records may gain internal fields as implementation needs change.
Machine-readable commands expose an allow-listed versioned contract instead:

```jsonc
{
  "schemaVersion": 1,
  "job": {
    "id": "job-...",
    "label": "dependency audit",
    "kind": "delegate",
    "status": "completed",
    "profile": "claude",
    "mode": "read-only",
    "afterJobIds": [],
    "reviewOfJobId": null
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

Host-facing inspection is bounded by default to protect an agent Host's context
window. Job lists show the newest 20 records, single-Job status omits logs, and
logs show the latest 20 rendered lines. Explicit `--all` and `--tail` controls
provide full-history and custom-window escape hatches; `result` remains the
dedicated final-answer surface. `wait --summary` blocks on the same completion
condition while returning bounded previews and artifact locations.

Job Labels are optional, non-unique human metadata. They improve recognition
after Host compaction but never participate in lookup, dependencies, lineage,
or authorization.

## State Layout

```text
~/.consult/
├── profiles.json
└── workspaces/<sha256-of-canonical-git-root>/
    ├── jobs/<job-id>.json
    ├── logs/<job-id>.log
    ├── brokers/<job-id>.json
    ├── artifacts/<job-id>/
    │   ├── egress.json                  # relayed volume per allowed host
    │   └── session-state/               # confined resume archive, when captured
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

`logs/<job-id>.log` is strict append-only NDJSON with four methods:
`consult/update`, `consult/finalized`, and `consult/steer` from the Job runtime
(ADR-0040), and `consult/report` from `consult report` (ADR-0039). Report lines
are single `O_APPEND` writes by an external process; readers drop a partially
flushed trailing line and re-read, and must ignore methods they do not
recognize.

## Interim Job Events

`consult report` appends one typed, bounded interim event to the running Job's
log: `blocked`, `decision_needed`, `discovery`, or `progress`, with an optional
JSON payload. The Job comes from `--job` or the injected `CONSULT_PARENT_JOB`,
and the Workspace from `CONSULT_WORKSPACE` or Git-root detection.

`consult events <job-id>` reads that stream back, deriving a 1-based sequence
number from the order of report and steer lines and synthesizing `queued`,
`running`, and `terminal` transitions from the Job record. `--since <seq>`
resumes after an event already read, `--type` selects one event type, `--json`
emits a small `{"schemaVersion":1,"jobId":...,"events":[...]}` envelope, and
`--follow` streams on the same 200 ms record poll as `logs --follow` (NDJSON
when combined with `--json`, exit 4 on the 30-minute deadline).

Bounds are enforced at the write — 4096-byte messages, 16 KiB serialized data,
256 reports per Job — because these lines bypass the Broker's persisted-log
accounting. Reporting requires `--sandbox inherit`, since confined Jobs cannot
execute `consult` at all.

A delegated Job reaches `consult report` through the one execute carve-out in
`permissions.mts` (ADR-0042). Real Profiles request permission before running a
shell command, and blanket execute denial meant they asked, were refused, and
gave up. The permission layer now approves an execute request when the Job's
confinement is `inherit`, the command parses as one simple invocation (argv
array, or a command string tokenized under shell rules and denied on any
metacharacter, with a single `bash -lc` unwrap), the binary realpaths to the
running installation's own `bin/consult`, and the argv is `report` plus only
`--type`, `--message`, `--data`, and the message after `--`. `--job` is excluded
so a Job cannot report as another Job. Confined Jobs keep unconditional denial,
every parse uncertainty denies, and all other execute requests keep their
existing diagnostics. The predicate lives in `report-exec-policy.mts` as a pure
function over `rawInput` plus injected resolvers; `job-agent.mts` resolves the
real binary once per Job, beside the `CONSULT_*` environment.

## Mid-Job Steering

`consult steer <job-id> -- <guidance>` sends guidance into a Job that is already
running (ADR-0040). The CLI dials the Job's Broker socket the way `consult
cancel` does; the Broker records one `consult/steer` line on the Job's log,
marks a pending steer, and cancels the in-flight prompt turn. When that turn
settles, the runner re-prompts the **same live Session** with the guidance
inside `BEGIN`/`END CONSULT SUPERVISOR GUIDANCE` delimiters instead of
finalizing, and the continued turn finalizes normally.

One Job therefore may run several prompt turns while keeping one id, one
Session, one log, one record, one wall-clock deadline, and one persisted-log
budget. The steer's cancel deliberately does not set the Job's cancel flag, so
the cancellation-wins record merge cannot make a steered Job look `cancelled`;
a real `consult cancel` that races a pending steer still wins and drops the
guidance.

Only `running` background non-isolated Jobs are steerable: foreground and
`--isolated` Jobs run their turn inline in the companion, with no socket another
process can reach, and refuse with exit 1. Guidance is bounded at 16 KiB and
rejected rather than truncated, one steer is in flight at a time (exit 3
otherwise), and a Job outside its running window refuses with exit 5. Steer
lines are metered against the same persisted-log limit as updates because they
are written by the Broker. `profileSupportsSteer` in `profile-launch-policy.mts`
is the per-Profile seam and is true for every registry Profile in v1.

## Capabilities

`consult capabilities [--json]` is the versioned surface a Host probes to learn
what a build supports (ADR-0041): the CLI version, the schema version of each
machine-readable contract (`jobResult`, `events`, `profiles`), which optional
commands exist (`report`, `events`, `steer`, plus the Profiles the registry
advertises native review for), and the bounds those commands enforce. Every
value is read from the constant the behavior is bounded by rather than restated.

Like `help` and `version` it is a static self-description: it resolves no
Workspace and reads no Job or Profile state, so it answers identically outside a
Git repository. It replaces exit-code probing, which cannot separate a missing
subcommand from a bad argument; a build older than 1.2.0 has no `capabilities`
command and exits 2, which is the documented fallback signal.

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

On POSIX systems, each Profile launch owns a new process group. Disposal closes
ACP stdin for a short graceful window, then signals the whole group with
SIGTERM and escalates to SIGKILL. Group liveness is checked independently of
the direct child pid so a descendant cannot survive merely because the group
leader exited first. Initialization failure and timeout use the same cleanup
path.

Isolated background Jobs may run the shared runtime inline inside their already
detached worker. This keeps original Workspace state separate from the
Execution Workspace without creating a second daemon contract. The worker pid
is recorded as the inline runner so `consult cancel` can signal it safely.

The external Job behavior is identical across transports. `jobId` is the
idempotency key for Broker requests; replay with a different payload is a
conflict. Payload identity includes permission-relevant execution opt-ins.

## Job Dependencies and Waiting

`delegate --background --after <job-id>` creates a Job Dependency. `--after`
is repeatable; every prerequisite must already exist in the same Workspace, so
dependency edges always point to existing Jobs and cannot form cycles through
the public CLI.

The dependent Job's detached worker waits up to 30 minutes for every
prerequisite to reach terminal state before it starts a Profile. Only
`completed` prerequisites release the prompt turn. A failed, cancelled, or
skipped prerequisite finalizes the dependent Job as `skipped` without a model
call. Successful prerequisite final text is appended to the original prompt in
declared order inside an explicitly untrusted, UTF-8-safe block capped at 256
KiB total. Dependencies do not apply isolated-write patches or imply lineage,
authority inheritance, or Session continuation.

`consult wait <job-id>...` performs one blocking join and returns the selected
versioned Job Results in argument order. It uses persisted Job records as the
source of truth and shares one 30-minute timeout. On SIGINT or SIGTERM, it
best-effort cancels still-active selected Jobs through normal cascade-aware
cancellation; `--keep-running` opts out. This gives shell-capable Hosts a
portable no-LLM-polling path without requiring Host-specific inbound prompt
APIs. A hard kill cannot execute cleanup.

`consult wait --summary` performs the same join but returns bounded one-line
outcomes so the Host can choose which full Results to load.

While a dependent worker is waiting, it handles SIGINT/SIGTERM before Profile
startup, records cancellation, and removes any prepared isolated Execution
Workspace. Once Profile execution begins, the normal Broker/inline lifecycle
owns process-tree and isolated-workspace cleanup.

## Sessions and Resume

`--resume` searches finalized delegate Jobs for the current Workspace, Host
Session, and Profile. `--resume-job <id>` selects an explicit compatible Job.
The new transport then uses:

1. ACP `session/resume` when advertised.
2. ACP `session/load` when resume is absent but load is advertised.
3. A clear `RESUME_UNSUPPORTED` failure otherwise.

Resume stays within one Profile. A different Profile receives a self-contained
new prompt rather than an attempted native session conversion.

Confined resume does not mount a shared Profile home. After confirmed Profile
tree termination and before private-home deletion, a Profile-specific adapter
selects exactly one Codex rollout or Claude project transcript, bounds and
hashes it, and atomically commits it beneath the source Job's private artifact
directory. The new Job carries both source Job id and native Session id;
preflight verifies the archive before Job creation and launch restores the same
relative transcript path into the fresh home. Missing, malformed, tampered,
cross-Profile, or cwd-mismatched archives fail closed. Confined isolated resume
remains unavailable because each detached Execution Workspace has a new cwd.
Transcripts can contain sensitive conversation content and live as long as
their Job artifacts; credentials and shared Profile indexes are never copied.

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

`review --job <job-id>` accepts only a completed isolated write Job with the
exact Consult-owned patch artifact path. Consult opens that patch without
following symlinks and supplies the source task, final report, touched-files
list, and bounded patch to the reviewer as untrusted data. The resulting review
records `reviewOfJobId`; it does not apply the patch or create lineage.

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

## Job Authority and Native Confinement

Job Authority schema v1 is the portable grant the trusted Host supplies before
Job creation:

```json
{
  "schemaVersion": 1,
  "mode": "read-only",
  "confinement": "confined",
  "allowFetch": false,
  "allowExecute": false
}
```

That exact object is canonicalized, persisted, hashed into payload identity,
and checked again at runtime boundaries. Defaults are read-only and confined.
`--write`, `--allow-fetch`, and `--sandbox inherit` are independent explicit
Host choices; Consult may narrow them but never broadens or retries implicitly.

Before resume lookup, diff capture, isolated-worktree creation, or Job
persistence, preflight initializes the exact configured Profile binary, args,
and environment inside the requested boundary. Unsupported combinations return
a structured authority diagnostic and create no Job. Native Windows and macOS
x64 processes are unsupported, including inheritance. Confined nesting is also
unsupported; cooperative ambient chains must request inheritance explicitly,
and linked child ceilings are not presented as an unforgeable OS boundary.

Preflight is an early compatibility check, not an immutable launch guarantee:
the Profile executable or Host credential state can change before the real
launch. The launch path derives and validates the full policy again, so such a
race can fail a created Job but cannot silently broaden its authority.

The confined adapter targets native Linux and native arm64 macOS for built-in
`codex` and `claude` Profile identities. Custom, `opencode`, and `copilot`
Profiles remain inherit-only until they pass the same live conformance gates. A trusted Host
may choose `--sandbox inherit`; that adds no Consult OS boundary and disables
the legacy `CONSULT_AGENT_SANDBOX` launch layer. `consult doctor` reports the
default confined readiness of the exact selected Profile in the current Host
context. In particular, nested Seatbelt can fail under an already-confined
macOS Codex Host even when an unrestricted terminal control passes.

Confined launch uses pinned `@anthropic-ai/sandbox-runtime@0.0.64` output as a
generated policy artifact, not as an unreviewed policy authority. Consult
version-checks and shape-checks that artifact, canonically requotes it, removes
shared default write grants, relocates Linux proxy socket binds after the
`/tmp` mount, injects authenticated proxy URLs, and fails closed on drift.
Linux uses bubblewrap network/PID/mount namespaces plus seccomp; macOS uses
Seatbelt. The Profile owns a new process group, and confinement is released
only after tree termination is confirmed.

On native arm64 macOS, executable read scopes recursively inspect absolute
Mach-O library links. Exact linked Homebrew formula/version roots and their
`opt` symlink aliases are readable, while broad `/usr`, `/usr/local`, the
Homebrew prefix, and the Cellar as a whole remain denied. System reads use exact
`/usr` subtrees instead. The generated Seatbelt transform restores lexical
aliases that the pinned runtime canonicalizes, including `/etc` for the already-allowed
`/private/etc`. When Homebrew OpenSSL is linked, Consult points it at an empty
Job-private configuration instead of exposing mutable Host OpenSSL config.

A Node-script Profile agent resolves its dependencies through the npm layout
around it, and package managers hoist those siblings outside the agent's own
package directory. Confined read scopes therefore follow the agent's declared
dependency closure — `dependencies` plus `optionalDependencies`, resolved by
Consult through the same `node_modules` lookup the agent will use — so the
mapped set stays what the agent declares rather than a whole shared prefix.
Dependencies that do not resolve are skipped, which is the normal case for
platform-specific optional packages, and the closure is bounded so an
unexpectedly large tree warns instead of widening the sandbox silently.

Each confined Job receives a private home, temp directory, XDG directories,
and a sanitized environment. Only one credential source is exposed: a
Profile-specific Consult credential variable is translated to the vendor
variable when present; otherwise the Profile's selected regular credential
file is copied into Job state. Ambient vendor variables are not credential
fallbacks.
Whole Host config
trees, MCP configuration, secret-manager paths, and ambient proxy variables are
not forwarded. Credentials are process-tree readable; the security property is
egress-constrained, not credential invisibility.

Consult does not broker macOS Keychain entries. A confined Claude Profile on
macOS must therefore receive one supported token environment variable or a
stageable `.claude/.credentials.json`; a Keychain-only Claude login cannot be
copied into the private Job home.

Before a trusted root Claude `delegate` or `review` stages an expired or
soon-to-expire regular OAuth file, Consult automatically initializes the exact
configured ACP Profile against the Host credential store, opens no model turn,
disposes it, and reruns the same confined preflight exactly once. The
proactive window (default two minutes, `CONSULT_CLAUDE_OAUTH_REFRESH_SKEW_MS`)
treats a credential expiring within the skew as refresh-eligible so it cannot
lapse between staging and the first confined model call. This Host-side refresh
is separate from Job launch and is enabled by default without a user option.
Nested Jobs, Doctor, and other diagnostic paths cannot trigger it — Doctor
classifies the credential observationally (`inspectClaudeHostOauth`) with a
zero skew instead. A failed or unchanged refresh creates no Job and never falls
back to ambient inheritance; explicit Consult credential variables continue to
bypass the Host OAuth file and are the durable fix for frequent expiry.

In particular, confined Codex does not copy Host `config.toml`, and confined
Claude does not copy Host `settings.json`. Model/provider preferences that
exist only in those files can therefore differ from inherited launches; the
Host should pass an explicit `--model` when the configured default matters.
Job roots are mode 0700 and carry an owner marker. A later preflight/launch
sweeps roots older than the wall-clock limit plus a grace period when the owner
pid is gone, covering SIGKILL/OOM orphans without deleting concurrent Jobs.

Direct networking is denied. An authenticated loopback HTTP/SOCKS proxy allows
only port 443, resolves all addresses in the Host, rejects private or mixed
answers, and dials one approved literal address. Without `--allow-fetch`, only
the Profile's model/auth host inventory is allowed. `--allow-fetch` permits
arbitrary public TCP/443 for task-specific research. This supports HTTPS but
does not inspect or prove the encrypted application protocol. Because the Profile also
holds its model credential, that grant increases prompt-injection exfiltration
risk; Consult deliberately does not add a credential broker in this version.

An allowed host is therefore still a data path, and the allowlist is host-granular:
a Profile that reaches its own model host cannot be distinguished from one that
abuses it, because the tunnel is opaque TLS. Consult records relayed volume per
allowed host for each confined Job in `artifacts/<job-id>/egress.json` so that a
bulk transfer is at least visible against a normal prompt turn. This is
observability, not enforcement: accounting is written best-effort after the
Profile tree is gone and never fails a Job. No ceiling is enforced, because a
blind cap either sits high enough to be useless or truncates a legitimate long
turn; choosing that number needs real data first.

ACP file handlers and permission-bearing paths remain realpath-confined to the
Execution Workspace and reject symlink escapes. Path extraction from ACP tool
calls recurses nested structures, matches field names case- and
separator-insensitively, and reads the typed `toolCall.locations` source, so a
path cannot evade confinement by hiding in a nested or differently-spelled
field. Extraction is bounded and fails closed if a payload exceeds those bounds:

Profile adapters own the ACP `session/prompt` terminal boundary. Consult does
not infer provider-internal background-task completion after a Profile has
returned a stop reason. For the maintained Claude adapter's known pre-0.59.0
async-subagent defect, Consult recognizes an explicit background `Agent`/`Task`
launch and rejects an early stop with a stable compatibility diagnostic. This
guard is feature-scoped: ordinary turns are not blanket-rejected by adapter
version, and 0.59.0+ retains lifecycle ownership in the Profile.

| Request kind | Read-only | Write | Write + fetch | `--allow-exec` requested |
| --- | --- | --- | --- | --- |
| read/search/think | allow, path-confined | allow, path-confined | allow, path-confined | allow, path-confined |
| edit/delete/move | deny | allow, path-confined | allow, path-confined | allow, path-confined |
| fetch | deny | deny | allow via public-TCP/443 proxy | deny |
| execute | deny | deny | deny | preflight rejects the Job |
| switch_mode/other | deny | allow | allow | deny |

Execute remains represented in canonical/persisted authority for compatibility,
but `--allow-exec` is unavailable until execute-specific resource containment
and cross-Profile conformance are complete. Wall-clock duration and persisted
NDJSON size are bounded now. Process count, CPU, memory, disk, and global
fan-out quotas remain documented residual risks rather than implied sandbox
guarantees; the trusted Host must bound concurrent Jobs.

Conformance is deliberately two-layered. A deterministic fake ACP Profile is
run through each built-in registry identity from the packed artifact to make
filesystem, network, lifecycle, isolation, resume, and cleanup assertions
mandatory. Separate real Codex and Claude controls prove vendor authentication,
ACP/model transport, and selective transcript compatibility. Model prompts are
not the sole proof of a security boundary because tool selection, fetch
availability, and cancellation timing are nondeterministic.

## Delegation Chains

Nested delegation uses `chainId`, `parentJobId`, and `delegationDepth`.
`CONSULT_PARENT_JOB` is injected into delegated environments, while an explicit
`--parent-job` wins. A child inherits Workspace, lineage, and a permission
ceiling but not model, effort, or resume choices. Default maximum depth is two.
Cancelling a parent cancels active descendants; child failure does not
automatically fail the parent. Parent linkage is child-controlled, so linked
ceilings and the depth limit are cooperative product policy rather than an
authenticated OS boundary.

## Packaging and Verification

Development uses Bun for package installation and scripts, while production
execution uses Node 22.18 or newer:

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
entrypoints and finalize a Job. On a native Host with sandbox dependencies,
`CONSULT_PACKAGE_SMOKE_CONFINED=1 bun run pack:check` additionally runs the full
deterministic boundary/lifecycle matrix through fake Codex and Claude registry
identities from the npm install, plus exact confined Doctor checks for both
identities from the Bun install, without a model call.

Behavior and architecture changes update this document and, when they make or
supersede a durable decision, add an ADR.
