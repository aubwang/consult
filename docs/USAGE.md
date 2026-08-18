# Consult Usage Reference

This page holds the operational details behind the shorter examples in the
[README](../README.md). The installed CLI documents itself, and its help is
authoritative for the version on your machine:

```sh
consult help              # commands, topics, and where to start
consult help <topic>      # delegation, authority, profiles, review, jobs,
                          # chains, contracts, guardrails
consult help <command>    # one command's flags and examples
consult delegate --help   # the same thing, from the command itself
consult help --all        # every topic at once
consult --version         # installed version, useful in bug reports
```

`consult help` is deliberately short and names the topics; each topic page is
one focused read. That is also how a coding agent learns to delegate well —
Consult ships no skills or plugins, so the CLI can never disagree with a
separately installed document.

## Profiles

Consult ships four built-in Profile definitions:

| Profile | Agent executable | Authentication | Confined authority |
| --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | `CONSULT_CLAUDE_API_KEY` or `CONSULT_CLAUDE_OAUTH_TOKEN`, otherwise a stageable credentials file. Keychain-only macOS login is not staged. | Native Linux and arm64 macOS after exact preflight. |
| `codex` | `codex-acp` | `CONSULT_OPENAI_API_KEY`, otherwise the underlying Codex CLI authentication. | Native Linux and arm64 macOS after exact preflight. |
| `opencode` | `opencode acp` | Configured opencode provider credentials. | Not yet; `--sandbox inherit` is required, so the Job runs with Host-ambient authority. |
| `copilot` | `copilot --acp` | Copilot CLI login (`/login`), `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` with a fine-grained PAT holding the Copilot Requests permission, or a `COPILOT_PROVIDER_*` BYOK provider (no GitHub login). | Not yet; `--sandbox inherit` is required, so the Job runs with Host-ambient authority hardened by Job-mode `--deny-tool` pins. |

Run `consult setup` to inspect available Profile executables or
`consult setup --install <profile>` to install and verify one. Custom Profiles
can be configured through Consult's generic Profile configuration.

The Claude Profile is supported, but Consult does not require or ship a Claude
Code plugin. The `copilot` Profile launches the GitHub Copilot CLI's native ACP
server — no shim. Gemini is not a supported Profile.

### Selecting a Profile

Every Profile-bearing command resolves one Profile in this order:

1. Explicit `--agent <profile>` (alias `--profile`) on the command itself.
2. The default recorded for the current Host identity.
3. The global default.

When none of those resolve, the command reports
`No profile selected. Available profiles: ...` and exits without creating a Job.
`consult agents` lists the configured Profiles with their defaults and records
new ones:

```sh
consult agents                            # Profiles, defaults, and hosts
consult agents --set claude --host codex  # default for the codex Host
consult agents --set claude               # global default
consult agents --help                     # selection and default help
```

Host identity resolves from explicit `--host`, Consult environment values, then
detected `OPENCODE_SESSION_ID` / `OPENCODE_RUN_ID` or `CODEX_THREAD_ID`, and
falls back to `terminal`. `consult doctor` prints the resolved `host`,
`default`, `hostDefault`, and `selected` Profile, and `consult doctor --agent
<profile>` checks one Profile without changing any default.

## Cold delegation

A delegate does not receive the Host's current conversation. Everything after
`--` is the prompt. Include the relevant paths, concrete question, constraints,
and acceptance criteria.

```sh
consult delegate --agent claude --read-only -- \
  "Inspect scripts/lib/process.mts for cancellation races; report findings only."
```

When a task depends on uncommitted work, attach a bounded deterministic snapshot
of the current diff:

```sh
consult delegate --agent claude --read-only --include-diff -- \
  "Review the attached change for correctness."

consult delegate --agent opencode --read-only --sandbox inherit \
  --include-diff --base main -- \
  "Identify compatibility risks relative to main."
```

The captured diff is marked as untrusted data and its resolved base metadata is
stored on the Job. The Profile sees that pinned snapshot rather than a moving
working tree.

Without `--base`, Consult pins the working-tree diff (staged and unstaged
tracked changes against HEAD). With `--base <ref>` it pins the `<ref>...HEAD`
commit range. `--base HEAD` is treated as the working-tree diff, since a commit
compared with itself has no hunks; to review uncommitted changes, prefer
omitting `--base`.

Pass `--model` and `--effort` for optional Profile-specific tuning. Consult
resolves family aliases only from models advertised by the Profile at Session
start. Omitting `--model` uses the confined Profile runtime's default; Host
configuration files are not copied into confinement.

The built-in Codex tier aliases expand to full model IDs: `sol` to
`gpt-5.6-sol`, `terra` to `gpt-5.6-terra`, and `luna` to `gpt-5.6-luna`.
Consult never sends those bare tier names to Codex as model IDs.

## Review

`review` creates a pinned, findings-first, read-only Job through any configured
Profile:

```sh
consult review --agent claude
consult review --agent opencode --sandbox inherit --base main
consult review --agent codex --base HEAD~1
```

Codex may use its verified native review capability. Other Profiles receive the
same review task through the portable delegation path.

Pass `--model` and `--effort` to tune the reviewing Profile exactly as for
`delegate`: family and tier aliases resolve against advertised models, and
effort selects among the reasoning options the Profile advertises.

## Job Authority

Every `delegate` and `review` defaults to read-only, Consult-managed
confinement. On native Linux and native arm64 macOS, built-in `codex` and
`claude` Profiles receive:

- Workspace access according to the selected mode;
- a private per-Job home and temporary directory;
- one selected credential source;
- only the system and runtime reads needed to start the configured Profile; and
- model traffic through an authenticated host-allowlist proxy, with direct
  networking blocked. The confined allowlist is `api.openai.com`,
  `chatgpt.com`, and `auth.openai.com` for `codex` (authentication and model
  traffic share the ChatGPT-backed endpoints) and `api.anthropic.com` for
  `claude`.

Preflight initializes the exact configured Profile before creating a Job.

### Public-web research

`--allow-fetch` permits arbitrary public TCP/443 through the Job proxy. Consult
does not terminate TLS or inspect the tunneled application protocol. Because
the Profile also holds its selected model credential, a prompt-injected Job can
send readable data to a public host. Consult does not currently broker
credentials; keep the Job's readable input narrow.

### Ambient inheritance

`--sandbox inherit` deliberately adds no Consult OS boundary: no private Job
home, no filesystem confinement, and no egress proxy. The Profile runs as an
ordinary Host process. It is an explicit escape hatch for a trusted Host and is
never selected as an automatic retry. Consult's Job policy — the selected
read-only or write mode, workspace path checks, and fetch and execute denial —
still applies at the agent-protocol permission layer, but it is cooperative and
detective under inheritance, so a Profile backend may act before Consult
observes a violation. Inheritance also passes the Host's ambient environment
without confined credential staging or translation, so vendor variables may
affect the Profile's native authentication.

Consult-managed confinement is implemented only for the built-in `codex` and
`claude` Profiles. Custom, opencode, and copilot Profiles always require
`--sandbox inherit`: a default confined `delegate` or `review` for them fails
preflight before any Job is created, and Consult never downgrades to
inheritance automatically. An opencode or copilot Job is therefore never
OS-sandboxed by Consult; treat it as running with the Host's own authority,
subject only to the cooperative Job policy above and any sandboxing the agent
runtime itself provides. For copilot, Consult additionally launches the CLI
with Job-mode `--deny-tool` pins (`shell` and `url` always, `write` unless
the Job grants writes), removes `COPILOT_ALLOW_ALL` from the child
environment (any defined value, even empty, would enable allow-all-tools),
pins `--no-auto-update`, and refuses Copilot CLI builds older than 1.0.60;
Copilot ranks deny rules above `--allow-all` and saved approvals, so
persisted allow-all state cannot bypass the Job Authority. Those pins govern
model-initiated tool calls only — Copilot hooks, custom instructions, and
user-configured MCP servers still run with the Host's ambient authority,
including during preflight's session probe. Copilot Session reopening
(`--resume`) is rejected because tool approvals persist across sessions.
The copilot Profile is preview support: its model-turn conformance matrix is
still auth-deferred. Confined nested delegation is unsupported. Native Windows and macOS
x64 processes, including Node under Rosetta, are unsupported even in inherited
mode.

Check the exact Host/Profile/authority combination first:

```sh
consult doctor --agent codex
```

Doctor stages the selected credential briefly, opens the confined proxy,
initializes the Profile, and disposes it. It does not send a model prompt. A
failed preflight creates no Job.

A Profile-specific Consult credential variable takes precedence over a Profile
credential file during confined launch and prevents that file from being
staged:

- `CONSULT_OPENAI_API_KEY` becomes `OPENAI_API_KEY` inside a Codex Job;
- `CONSULT_CLAUDE_API_KEY` becomes `ANTHROPIC_API_KEY` inside a Claude Job; and
- `CONSULT_CLAUDE_OAUTH_TOKEN` becomes `CLAUDE_CODE_OAUTH_TOKEN` inside a
  Claude Job.

Ambient vendor variables are ignored for Profile authentication, so a
project's `OPENAI_API_KEY` does not replace the ChatGPT login represented by
`auth.json`. Setting both Claude-specific Consult variables is an error.

A trusted root `delegate` or `review` using a stageable Claude OAuth file
automatically makes one no-prompt Host refresh attempt when that file is
expired **or about to expire**, then reruns exact confined preflight once. The
proactive window defaults to two minutes and is configurable through
`CONSULT_CLAUDE_OAUTH_REFRESH_SKEW_MS` (`0` restores strict already-expired
behavior); it stops a credential that is valid at preflight from expiring
between staging and the first confined model call. The attempt uses the exact
configured Claude ACP Profile against the Host credential store; it never
copies credentials back from a Job-private home and never sends a model
prompt. Nested Jobs and diagnostic commands do not refresh Host credentials.
If the Host is fully logged out, the command fails before Job creation with
`claude auth login` remediation. No flag or setting is required.

Because each confined Job stages a fresh snapshot of the OAuth file and cannot
refresh it from inside the sandbox, the most durable fix for frequent expiry is
a long-lived token: set `CONSULT_CLAUDE_OAUTH_TOKEN` (generate one with `claude
setup-token`) or `CONSULT_CLAUDE_API_KEY` in the Host environment. Explicit
Consult credential variables bypass the OAuth file entirely, so they never
expire mid-run and skip the Host refresh path.

Confined launch does not copy Codex `config.toml` or Claude `settings.json`.
Pass `--model` explicitly when Host configuration controls model or provider
selection.

Confined Claude on macOS requires `CONSULT_CLAUDE_API_KEY`,
`CONSULT_CLAUDE_OAUTH_TOKEN`, or a stageable `.claude/.credentials.json`; a
Keychain-only login is unavailable in the private Job home. Consult deliberately
does not broker the macOS Keychain.

`--allow-exec` remains unavailable while execute-specific resource limits and
cross-Profile conformance are incomplete. A delegated Job can read and edit
files according to its mode but cannot run commands — tests, linters, builds,
or generators — so the Host runs verification after the Job returns. Confined
Jobs have wall-clock and persisted-log limits, but no process-count, CPU,
memory, disk, or global fan-out quota. The trusted Host must bound concurrent
delegates.

## Write Jobs and artifacts

An in-place write Job edits the current checkout:

```sh
consult delegate --agent codex --write -- "Add a focused test."
```

For delegated implementation, prefer an isolated write Job:

```sh
consult delegate --agent codex --write --isolated --label "focused fix" -- \
  "Implement the focused fix and add a regression test."
```

An isolated Job seeds a detached Git worktree from current staged, unstaged,
and safe nonignored untracked state. Gitignored files are neither seeded nor
captured. When the Job ends, Consult records an agent-only binary patch and a
touched-files manifest, removes the temporary worktree, and leaves the original
checkout unchanged. The repository needs at least one commit to provide a
stable base.

The isolated worktree is a transactional boundary separate from native process
confinement. Confined Job Authority still applies by default, and execute
authority stays unavailable: the delegate edits files but cannot run tests or
builds, so verify the patch Host-side before or after applying it.

Review a completed isolated Job directly from its Consult-owned artifacts:

```sh
consult review --agent claude --job <implementation-job-id> \
  --label "implementation review"
```

The source task, final report, touched-files list, and patch are pinned as
bounded untrusted input. The review does not apply the patch. `--job` and
`--base` are mutually exclusive.

## Background Jobs

Claude background subagents require
`@agentclientprotocol/claude-agent-acp` 0.59.0 or newer. Earlier maintained
adapter versions can return `end_turn` immediately after launching an async
`Agent`/`Task`, before its result and follow-up message arrive. Consult detects
that exact incompatible turn and finalizes it as
`CLAUDE_ASYNC_FINALIZATION_UNSUPPORTED` instead of recording the interim text
as a successful Job Result. Update the Profile and retry:

```sh
npm install --global @agentclientprotocol/claude-agent-acp@^0.59.0
consult doctor --agent claude
```

Normal Claude turns, including synchronous tool use and synchronous
subagents, remain available on older adapter versions. Consult does not
reimplement the Claude SDK's background-task lifecycle; compatible Profile
adapters own the terminal `session/prompt` boundary.

```sh
consult delegate --agent opencode --read-only --sandbox inherit \
  --background -- "Trace the bug."
consult wait <job-id> [<job-id>...]
consult wait --summary <job-id> [<job-id>...]
consult status <job-id>
consult logs <job-id> --tail 10
consult events <job-id>
consult steer <job-id> -- "the schema is frozen; skip the migration"
consult result <job-id>
consult chain <job-id>
consult cancel <job-id>
```

A foreground delegation streams updates and the final response. A background
delegation returns a queued Job immediately. Each normal background Job gets a
Job-scoped Broker; an isolated worker may host the same runtime inline so its
execution directory remains separate from the original Workspace.

Prefer `wait` when the Host needs the answer: one blocking CLI call avoids
model-driven polling. Add `--summary` when the Host needs only bounded result
previews and artifact paths, then use `result` for a selected full answer.
`--summary` and `--json` are mutually exclusive. `status` lists only the newest
20 Jobs by default, and a single-Job status is a concise summary without log
output; use `status --all`
for complete history. `logs` prints the latest 20 rendered lines by default;
use `--tail <n>` for another bounded window, `--all` for complete history, or
`--follow` to seed the bounded window and then stream new updates. `result`
returns the final Job answer.

A `completed` Job means its Profile turn ended successfully at the transport
level. The Host still needs to judge whether the final text actually completed
the delegated task.

### Interim Job events

A Job normally says everything at once, when its turn ends. `consult report`
lets a running Job say something before then, and `consult events` reads the
stream back:

```sh
consult report --type blocked -- "need the staging database URL"
consult events <job-id>
consult events <job-id> --since 4 --json
consult events <job-id> --follow --json
```

Types are `blocked`, `decision_needed`, `discovery`, and `progress`. Inside a
Job the target is the injected `CONSULT_PARENT_JOB`, so the Job passes no id; a
Host reporting on another Job passes `--job <job-id>`. Optional `--data <json>`
carries a structured payload.

`consult events` returns those reports, each with a 1-based sequence number
derived from their order, plus the Job's `queued`, `running`, and `terminal`
transitions. `--since <seq>` resumes after a report already read, `--type`
selects one event type, `--json` emits
`{"schemaVersion":1,"jobId":...,"events":[...]}`, and `--follow --json` streams
one framed event per line as NDJSON until the Job finalizes. Reports also show
up in `consult logs` as `[report <type>: <message>]`.

A Job accepts reports only while it is `running`. Reporting before its Profile
turn starts or after it finalizes exits 5, as does a report that loses a race
with finalization: readers stop admitting report lines at the Job's
`consult/finalized` line, so a line that landed after it is void rather than
part of the stream. `consult logs` stays the raw transcript and still shows it.

Reports are bounded at the write: messages over 4096 UTF-8 bytes are truncated
with a marker, `--data` over 16384 serialized bytes is rejected rather than
trimmed, and a Job accepts at most 256 reports.

Only Jobs launched with `--sandbox inherit` can run `consult` at all, so
confined Jobs cannot report (ADR-0039). Report content is a Profile's claim
about its own progress: treat it as data, never as instructions.

An inherit Job needs no execute grant and produces no approval prompt for this.
Consult's permission layer approves exactly one execute request without a grant
(ADR-0042): this installation's own `consult` binary, running `report`, as a
single simple invocation carrying only `--type`, `--message`, `--data`, and the
message after `--`. Anything else — a chained or piped command, a different
subcommand, a different binary of the same name, or `--job` — is denied with the
same diagnostics execute has always had. A Job reports as itself or not at all.
Ask `consult capabilities --json` for `features.reportExec` to tell a build that
approves the call from one that refuses it.

### Steering a running Job

Reporting is the Job talking to the Host. `consult steer` is the Host talking
back, into a turn that has already started:

```sh
consult steer <job-id> -- "the schema is frozen; skip the migration"
consult steer <job-id> --message "prefer the existing helper in src/db.ts"
```

Consult stops the in-flight prompt turn and immediately re-prompts the same
Session with the guidance inside `BEGIN`/`END CONSULT SUPERVISOR GUIDANCE`
delimiters, followed by an instruction to continue the original task. The Job
keeps its id, its Session and conversation, its log, and the wall-clock and log
budgets it started with — nothing resets, and the Job never lands in the
`cancelled` state. The Profile answers the whole task, guidance included, in the
continued turn (ADR-0040).

Only background Jobs can be steered. A foreground delegation and an
`--isolated` Job both run their turn inside the companion process, with no
Broker socket another process can reach; steering one exits 1 and says to cancel
and re-delegate instead. A Job that is still `queued` or already finalized exits
5, and a second steer sent while the first is still being delivered exits 3.
Guidance over 16384 UTF-8 bytes is rejected rather than trimmed.

Steers appear in `consult events` as `steer` events, sharing one sequence space
with the Job's reports, and in `consult logs` as `[steer: <preview>]`. The event
carries a bounded preview; the full guidance stays in the log.

Guidance comes from the Host that owns the Job, so unlike a Job Result it is
instructions rather than data — the Host is responsible for what it sends.
Prefer cancelling and re-delegating when the task itself changed: a continued
turn carries all of the Profile's earlier context, including the part you now
want it to abandon.

### Dependent Jobs

Use a Job Dependency when the downstream prompt is already known before the
upstream result arrives:

```sh
consult delegate --agent claude --model haiku --allow-fetch --background -- \
  "Research the remaining tournament teams and cite reliable sources."

consult delegate --agent codex --background --after job-research -- \
  "Compare the teams using the upstream research."

consult wait job-research job-comparison
```

`--after` is repeatable and background-only. Every prerequisite must already
exist in the same Workspace. The dependent worker waits up to 30 minutes for
all prerequisites. Completed Jobs release it and their final text is appended
in declared order inside a UTF-8-safe untrusted-data block capped at 256 KiB.
If any prerequisite fails, is cancelled, or is skipped, the dependent Job is
also `skipped` without starting its Profile.

Dependencies are orchestration, not Delegation Chain lineage. They do not
inherit authority, apply isolated-write patches, continue a Profile Session, or
create cancellation parentage. The dependent Job receives exactly the
authority selected on its own command.

Use `consult wait <job-id>...` to make one blocking tool call and receive every
selected terminal Job Result in argument order. No LLM polling occurs while the
CLI waits. SIGINT and SIGTERM best-effort cancel still-active selected Jobs and
their linked descendants; use `--keep-running` to stop waiting without
cancelling them. SIGKILL cannot run cleanup.

Do not predeclare a dependency when seeing the upstream answer could change
whether the next Job should exist or alter its prompt, Profile, model, or
authority. In that case, wait, inspect, and let the Host make the decision.

## Resume and lineage

Use `--resume` to continue the latest finalized Job for the selected Profile in
the current Host Session, `--resume-job <id>` to select a compatible prior Job,
or `--fresh` to start over.

Confined Codex and Claude Jobs archive only the completed native Session
transcript and restore that hash-verified file into the next private Job home.
Missing or incompatible state fails before a resume Job is created. Confined
resume with `--isolated` is unsupported because the execution Workspace changes.
Consult does not translate conversation state between different agent CLIs.

Nested cooperative delegation can pass `--parent-job <id>` or inherit
`CONSULT_PARENT_JOB`. Consult checks the declared parent's permission mode and a
maximum depth of two. Parent linkage comes from child-controlled arguments or
environment, so it is product policy rather than an authenticated security
boundary.

## JSON output

Use `--json` with `delegate`, `review`, `status`, `wait`, `result`, `logs`,
`events`, `chain`, `doctor`, `agents`, `setup`, `brokers`, and `capabilities`.
Job-bearing commands use a versioned envelope:

```json
{
  "schemaVersion": 1,
  "job": {},
  "outcome": {},
  "artifacts": {},
  "lineage": {}
}
```

`outcome.finalText` contains the Profile's agent-message text rather than
rendered tool-call markers. `job.afterJobIds` lists declared prerequisites;
`job.label` is optional non-unique human metadata and `job.reviewOfJobId`
identifies an isolated implementation reviewed by a review Job.
`wait --json` returns a `jobs` collection of the same payloads. Internal Job
record fields are not a public API. Status JSON does not embed log tails; use
`logs --json` when structured updates are explicitly needed.

## Detecting what a build supports

`consult capabilities --json` reports what the installed build can do, so a Host
never has to run a command to find out whether it exists:

```json
{
  "schemaVersion": 1,
  "version": "1.2.0",
  "contracts": { "jobResult": 1, "events": 1, "profiles": 1 },
  "features": {
    "report": true,
    "events": true,
    "steer": true,
    "nativeReviewProfiles": ["codex"]
  },
  "bounds": {
    "reportMessageBytes": 4096,
    "reportDataBytes": 16384,
    "reportsPerJob": 256,
    "steerGuidanceBytes": 16384
  }
}
```

`contracts` gives the schema version of each machine-readable envelope,
`features` names the optional commands this build ships, and `bounds` carries
the limits they enforce, so a Host can size a report or a steer before sending
it. Without `--json` the same report prints as a short table.

Capabilities is a static self-description like `help` and `version`: it reads no
Workspace, Job, or Profile state and works outside a Git repository. Builds
before 1.2.0 have no `capabilities` command and exit 2 with
`unknown subcommand: capabilities`; treat that as `report`, `events`, and
`steer` being unavailable. That is the only exit-code probe worth doing, and
only for pre-1.2 builds (ADR-0041).

Note that `features` describes the build, not a given Job. `steer` still refuses
an unsteerable Profile or an isolated Job at call time, and `report` still needs
an inherit-sandbox Job.

## Host Identity

Consult resolves Host Identity in this order:

1. `--host` and `--host-session` flags.
2. `CONSULT_HOST` and `CONSULT_HOST_SESSION_ID`.
3. `CODEX_THREAD_ID`, or `OPENCODE_SESSION_ID` / `OPENCODE_RUN_ID`.
4. `terminal/default`.

Claude Code is not auto-detected. A Claude spawning Host should pass
`--host claude-code --host-session <stable-session-id>` or set the matching
environment variables; otherwise its Jobs use the shared `terminal/default`
scope.

Host Identity scopes defaults, resume lookup, lineage, and lifecycle metadata.
The same `consult` CLI remains the product interface from every Host.

## State and troubleshooting

Global Profile configuration lives at `~/.consult/profiles.json`. Per-Workspace
Jobs, logs, Brokers, and isolated-write artifacts live under:

```text
~/.consult/workspaces/<sha256-of-workspace-root>/
```

Useful diagnostics:

```sh
consult doctor
consult status <job-id>
consult logs <job-id> --tail 10
consult brokers
consult brokers --cleanup
```

If authentication fails, sign in with the Profile's native CLI first, then
rerun `consult doctor --agent <profile>`. For a Claude Profile, `consult doctor`
reports a `claude oauth` line — `valid`, `expiring`, `expired`, `absent`,
`unreadable`, or `explicit CONSULT_CLAUDE_* credential` — and points at the
durable-token fix when the stageable credential needs attention; the check is
observational and never refreshes. For an expired or soon-to-expire Claude
OAuth file, an explicit `CONSULT_CLAUDE_OAUTH_TOKEN` (from `claude setup-token`)
or `CONSULT_CLAUDE_API_KEY` bypasses the file and avoids repeated expiry. A
trusted root Claude `delegate` or `review` automatically tries one Host refresh
and reruns exact preflight; Doctor and nested Jobs remain diagnostic-only.
Consult never retries with ambient inheritance automatically.

If preflight, `doctor`, or `setup --install` fails with
`process target remained alive after SIGKILL`, the Profile's process group
outlived the teardown grace rather than refusing to die. A Profile group is
several processes — an ACP shim plus the vendored agent binary and its
children — and a loaded or containerized host can take a second or more to
reap all of them. Raise the ceiling with `CONSULT_FORCE_KILL_GRACE_MS`
(milliseconds, default `5000`); teardown returns as soon as the group is gone,
so a larger value costs nothing when the host is healthy.

## Teaching a Host to delegate

Consult ships no agent skills, plugins, or Host adapters: the CLI is the whole
product surface, and `consult help` carries the judgment a Host needs. Point
your agent at it once, in whatever instruction file it already reads
(`AGENTS.md`, `CLAUDE.md`, a system prompt):

> For second opinions, delegated implementation, or cold review, use Consult.
> Run `consult help` first.

From there the agent discloses what it needs progressively:

| Topic | Covers |
| --- | --- |
| `delegation` | When a handoff pays for itself, cold-prompt structure, model and effort routing. |
| `authority` | Read-only, write, isolated, fetch, and sandbox modes, and how to phrase authority constraints in a prompt. |
| `profiles` | Claude, Codex, opencode, and Copilot specifics: model naming, authentication, per-Profile limits. |
| `review` | Pinned reviews, reviewing a completed Job, and running the fix loop outside the main thread. |
| `jobs` | Background Jobs, waiting, dependencies, sessions, and bounded inspection. |
| `reporting` | Interim Job events: what a running Job can say, and how to read it back. |
| `steering` | Sending guidance into a Job that is already running, and when to prefer cancelling. |
| `chains` | Nested delegation, authority ceilings, and lineage. |
| `contracts` | The semantic report contract, Job Result JSON, capabilities JSON, and exit codes. |
| `guardrails` | Treating results as data, secrets, and never widening authority on failure. |

`consult help --all` prints the whole set in one pass for a Host that wants it
preloaded rather than fetched on demand.

An agent that only ever runs `consult help` is reading the same version it is
about to invoke, which is the point: guidance shipped separately from the binary
drifts from it.
