# Consult Usage Reference

This page holds the operational details behind the shorter examples in the
[README](../README.md). Run `consult help` for a quick command overview or
`consult help --reference` for the exact CLI contract installed on your machine.

## Profiles

Consult ships three built-in Profile definitions:

| Profile | Agent executable | Authentication | Confined authority |
| --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | `CONSULT_CLAUDE_API_KEY` or `CONSULT_CLAUDE_OAUTH_TOKEN`, otherwise a stageable credentials file. Keychain-only macOS login is not staged. | Native Linux and arm64 macOS after exact preflight. |
| `codex` | `codex-acp` | `CONSULT_OPENAI_API_KEY`, otherwise the underlying Codex CLI authentication. | Native Linux and arm64 macOS after exact preflight. |
| `opencode` | `opencode acp` | Configured opencode provider credentials. | Not yet; explicit inheritance is required. |

Run `consult setup` to inspect available Profile executables or
`consult setup --install <profile>` to install and verify one. Custom Profiles
can be configured through Consult's generic Profile configuration.

The Claude Profile is supported, but Consult does not require or ship a Claude
Code plugin. Gemini and GitHub Copilot are not supported Profiles.

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

## Job Authority

Every `delegate` and `review` defaults to read-only, Consult-managed
confinement. On native Linux and native arm64 macOS, built-in `codex` and
`claude` Profiles receive:

- Workspace access according to the selected mode;
- a private per-Job home and temporary directory;
- one selected credential source;
- only the system and runtime reads needed to start the configured Profile; and
- model traffic through an authenticated host-allowlist proxy, with direct
  networking blocked.

Preflight initializes the exact configured Profile before creating a Job.

### Public-web research

`--allow-fetch` permits arbitrary public TCP/443 through the Job proxy. Consult
does not terminate TLS or inspect the tunneled application protocol. Because
the Profile also holds its selected model credential, a prompt-injected Job can
send readable data to a public host. Consult does not currently broker
credentials; keep the Job's readable input narrow.

### Ambient inheritance

`--sandbox inherit` deliberately adds no Consult OS boundary. It is an explicit
escape hatch for a trusted Host and is never selected as an automatic retry.
Read-only and path policy are cooperative and detective under inheritance, so a
Profile backend may act before Consult observes a violation. Inheritance also
passes the Host's ambient environment without confined credential staging or
translation, so vendor variables may affect the Profile's native authentication.

Confined nested delegation is unsupported. Custom and opencode Profiles require
inheritance. Native Windows and macOS x64 processes, including Node under
Rosetta, are unsupported even in inherited mode.

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
expired, then reruns exact confined preflight once. The attempt uses the exact
configured Claude ACP Profile against the Host credential store; it never
copies credentials back from a Job-private home and never sends a model
prompt. Nested Jobs and diagnostic commands do not refresh Host credentials.
If the Host is fully logged out, the command fails before Job creation with
`claude auth login` remediation. No flag or setting is required.

Confined launch does not copy Codex `config.toml` or Claude `settings.json`.
Pass `--model` explicitly when Host configuration controls model or provider
selection.

Confined Claude on macOS requires `CONSULT_CLAUDE_API_KEY`,
`CONSULT_CLAUDE_OAUTH_TOKEN`, or a stageable `.claude/.credentials.json`; a
Keychain-only login is unavailable in the private Job home. Consult deliberately
does not broker the macOS Keychain.

`--allow-exec` remains unavailable while execute-specific resource limits and
cross-Profile conformance are incomplete. Confined Jobs have wall-clock and
persisted-log limits, but no process-count, CPU, memory, disk, or global fan-out
quota. The trusted Host must bound concurrent delegates.

## Write Jobs and artifacts

An in-place write Job edits the current checkout:

```sh
consult delegate --agent codex --write -- "Add a focused test."
```

For delegated implementation, prefer an isolated write Job:

```sh
consult delegate --agent codex --write --isolated --label "focused fix" -- \
  "Implement the focused fix and run the relevant checks."
```

An isolated Job seeds a detached Git worktree from current staged, unstaged,
and safe nonignored untracked state. Gitignored files are neither seeded nor
captured. When the Job ends, Consult records an agent-only binary patch and a
touched-files manifest, removes the temporary worktree, and leaves the original
checkout unchanged. The repository needs at least one commit to provide a
stable base.

The isolated worktree is a transactional boundary separate from native process
confinement. Confined Job Authority still applies by default.

Review a completed isolated Job directly from its Consult-owned artifacts:

```sh
consult review --agent claude --job <implementation-job-id> \
  --label "implementation review"
```

The source task, final report, touched-files list, and patch are pinned as
bounded untrusted input. The review does not apply the patch. `--job` and
`--base` are mutually exclusive.

## Background Jobs

```sh
consult delegate --agent opencode --read-only --sandbox inherit \
  --background -- "Trace the bug."
consult wait <job-id> [<job-id>...]
consult wait --summary <job-id> [<job-id>...]
consult status <job-id>
consult logs <job-id> --tail 10
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
`chain`, `doctor`, `agents`, `setup`, and `brokers`. Job-bearing commands use a
versioned envelope:

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
rerun `consult doctor --agent <profile>`. For an expired Claude OAuth file, an
explicit `CONSULT_CLAUDE_OAUTH_TOKEN` or `CONSULT_CLAUDE_API_KEY` bypasses the
file. A trusted root Claude `delegate` or `review` automatically tries one
Host refresh and reruns exact preflight; Doctor and nested Jobs remain
diagnostic-only. Consult never retries with ambient inheritance automatically.

## Optional agent skills

The repository ships a generic `$consult` skill and convenience skills for
asking Claude, Codex, and opencode under [`skills/`](../skills/). Install the
desired skill for coding agents in the current project with:

```sh
npx skills add aubwang/consult
```

Project-local installation is the default. To make the selected skill available
to the selected coding agents across projects, install it globally:

```sh
npx skills add aubwang/consult --global
```

The Skills CLI prompts for the Consult skill and detected coding agents. Its
explicit selection flags remain available for non-interactive setup, but the
short commands above are the recommended interactive path.

Skill installation is optional and separate from installing the Consult CLI.
If you do not want to use the Skills CLI, copy or symlink one of the four
user-facing folders (`consult`, `ask-claude`, `ask-codex`, or `ask-opencode`)
from the installed npm package into the relevant agent's local or global skill
directory.

The tracked [`opencode` skill entrypoint](../.opencode/skills/consult) exposes
the generic skill from a repository checkout. These helpers teach a Host when
and how to delegate, but the CLI remains the integration boundary.
