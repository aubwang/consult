# Consult Usage Reference

This page holds the operational details behind the shorter examples in the
[README](../README.md). Run `consult help` for the exact CLI surface installed
on your machine.

## Profiles

Consult ships three built-in Profile definitions:

| Profile | Agent executable | Authentication | Confined authority |
| --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | A stageable credentials file or one supported token variable. Keychain-only macOS login is not staged. | Native Linux and arm64 macOS after exact preflight. |
| `codex` | `codex-acp` | The underlying Codex CLI authentication. | Native Linux and arm64 macOS after exact preflight. |
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
Profile backend may act before Consult observes a violation.

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

Confined launch does not copy Codex `config.toml` or Claude `settings.json`.
Pass `--model` explicitly when Host configuration controls model or provider
selection.

Confined Claude on macOS requires a supported token variable
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`) or a
stageable `.claude/.credentials.json`; a Keychain-only login is unavailable in
the private Job home. Consult deliberately does not broker the macOS Keychain.

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
consult delegate --agent codex --write --isolated -- \
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

## Background Jobs

```sh
consult delegate --agent opencode --read-only --sandbox inherit \
  --background -- "Trace the bug."
consult status <job-id> --wait
consult logs <job-id> --follow
consult result <job-id>
consult chain <job-id>
consult cancel <job-id>
```

A foreground delegation streams updates and the final response. A background
delegation returns a queued Job immediately. Each normal background Job gets a
Job-scoped Broker; an isolated worker may host the same runtime inline so its
execution directory remains separate from the original Workspace.

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

Use `--json` with `delegate`, `review`, `status`, `result`, `logs`, `chain`,
`doctor`, `agents`, `setup`, and `brokers`. Job-bearing commands use a versioned
envelope:

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
rendered tool-call markers. Internal Job record fields are not a public API.

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
consult logs <job-id> --follow
consult brokers
consult brokers --cleanup
```

If authentication fails, sign in with the Profile's native CLI first, then
rerun `consult doctor --agent <profile>`. Consult does not refresh vendor
credentials or retry with ambient inheritance automatically.

## Optional agent skills

The repository ships a generic `$consult` skill and convenience skills for
asking Claude, Codex, and opencode under [`skills/`](../skills/). The tracked
[`opencode` skill entrypoint](../.opencode/skills/consult) exposes the generic
skill from a checkout. These helpers can teach a Host the command surface, but
they are optional: the CLI is the integration boundary.
