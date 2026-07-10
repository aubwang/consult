# Consult

Delegate a self-contained coding task to another locally configured agent from
the terminal, Codex, or opencode.

```text
$ consult review --agent claude --base main
consult review job-a1b2 completed

$ consult delegate --agent codex --write --isolated --background -- \
    "add regression coverage for cancellation"
consult delegate job-c3d4 queued
consult status job-c3d4

$ consult status job-c3d4 --wait
job-c3d4 completed

$ consult result job-c3d4
Added the regression tests and verified the focused suite.
```

Consult is aimed at agentic delegation: one **Host** sends one cold,
self-contained prompt turn to a **Profile**. Every turn is a durable **Job**
with status, logs, lineage, result text, and optional artifacts.

## Install

Node.js 24 or newer is required. Install the supported npm package:

```sh
npm install --global @aubwang/consult
```

Then verify the CLI and configure a Profile:

```sh
consult help
consult setup
consult setup --install claude
consult agents --set claude
```

Consult uses Bun for dependency management when developing the repository, but
the installed CLI runs on Node and does not require Bun. See
[docs/INSTALL.md](docs/INSTALL.md) for linking a development checkout.

## Profiles

Consult ships three Profile definitions:

| Profile | Agent executable | Authentication | Job Authority |
| --- | --- | --- | --- |
| `claude` | `claude-agent-acp` | Uses a stageable credentials file or one supported token variable. Keychain-only macOS login is not staged. | Confined after per-context preflight. |
| `codex` | `codex-acp` | Uses the underlying Codex CLI authentication. | Confined after per-context preflight. |
| `opencode` | `opencode acp` | Uses configured opencode provider credentials. | Explicit inheritance only. |

The Claude Profile remains supported; Consult does not ship a Claude Code
plugin or slash-command Host Adapter. Gemini and GitHub Copilot Profiles are
not part of the supported product.

Run `consult setup` to see which Profile executables are available, or
`consult setup --install <profile>` to install and verify one. Custom Profiles
can still be configured through Consult's generic Profile configuration.

## Delegate

Read-only is the default:

```sh
consult delegate --agent claude --read-only -- \
  "inspect scripts/lib/process.mts for cancellation races; report findings only"
```

The delegate does not receive your current conversation. Include the relevant
paths, concrete question, constraints, and acceptance criteria in the prompt.

Attach a deterministic snapshot of the current diff when the task depends on
uncommitted work:

```sh
consult delegate --agent claude --read-only --include-diff -- \
  "review the attached change for correctness"

consult delegate --agent opencode --read-only --sandbox inherit \
  --include-diff --base main -- \
  "identify compatibility risks relative to main"
```

`--include-diff` captures the diff before delegation, bounds its size, marks it
as untrusted data, and stores the resolved base metadata on the Job. The
Profile reviews that snapshot rather than a moving working tree.

Use `--model` and `--effort` for optional Profile-specific tuning. Model family
aliases currently include `sol`, `terra`, and `luna` for Codex, and `opus`,
`sonnet`, `haiku`, and `fable` for Claude. Omitting `--model` uses the confined
Profile runtime's default; Host config files are not copied into confinement.

## Review

`review` works with every configured Profile:

```sh
consult review --agent claude
consult review --agent opencode --sandbox inherit --base main
consult review --agent codex --base HEAD~1
```

Consult resolves and pins the review diff itself. Codex can use its verified
native review capability; other Profiles receive the same findings-first,
read-only review Job through the portable delegation path.

## Job Authority

Every `delegate` and `review` defaults to read-only, Consult-managed
confinement. On native Linux and macOS, built-in `codex` and `claude` Profiles
run with only the Execution Workspace, a private per-Job home/temp directory,
and one selected model credential exposed. Direct networking is blocked; model
traffic goes through an authenticated allowlist proxy. Preflight initializes
the exact configured Profile before creating a Job.

Use `--allow-fetch` only when the Profile should perform task-specific web
research itself. It permits arbitrary public TCP/443 through the proxy (the
transport used by HTTPS clients, without TLS termination or application-
protocol inspection). Because the Profile also holds its model credential,
fetch increases the blast radius
of prompt injection; Consult does not currently broker credentials.

`--sandbox inherit` is the explicit escape hatch when the trusted Host accepts
ambient authority. It adds no Consult OS boundary and is never selected as an
automatic retry. Under inheritance, read-only and path policy are cooperative
and detective rather than OS-preventive; a Profile backend may act before
Consult observes a violation. Confined nested delegation is unsupported. Custom and
`opencode` Profiles currently require inheritance. Native Windows is not
supported, including inherited mode. Check the exact combination first:

```sh
consult doctor --agent codex
```

Doctor performs a real ACP initialization: it briefly stages the selected
credential, opens the confined proxy, starts the Profile, and disposes it. It
does not send a model prompt. Confined launch does not copy Codex
`config.toml` or Claude `settings.json`; pass `--model` explicitly when Host
config controls the desired model/provider behavior.

Consult deliberately does not broker the macOS Keychain. Confined Claude on
macOS therefore requires a supported token variable (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`) in the Host environment,
or a stageable `.claude/.credentials.json`; a Keychain-only Claude login is not
sufficient for the private Job home.

`--allow-exec` remains unavailable while execute-specific resource limits and
cross-Profile conformance are incomplete.

## Write Jobs and Artifacts

In-place writes remain available for compatibility:

```sh
consult delegate --agent codex --write -- "add a focused test"
```

For agentic delegation, prefer an isolated write Job:

```sh
consult delegate --agent codex --write --isolated -- \
  "implement the focused fix and run the relevant checks"
```

An isolated Job seeds a detached Git worktree from the current staged,
unstaged, and safe nonignored untracked state. Gitignored files are neither
seeded nor captured in the final patch, including ignored output created by the
Profile. The Profile edits that worktree, not the
checkout you are using. When the Job ends, Consult records an agent-only binary
patch plus a touched-files manifest, then removes the temporary worktree. The
original Workspace remains unchanged. The repository must have at least one
commit so the detached worktree has a stable base.

Isolated worktrees are a transactional boundary distinct from native process
confinement. Consult applies confined Job Authority by default:

```sh
consult delegate --agent codex --write --isolated -- \
  "make the change"
```

## Background Jobs, Results, and Resume

```sh
consult delegate --agent opencode --read-only --sandbox inherit \
  --background -- "trace the bug"
consult status <job-id> --wait
consult logs <job-id> --follow
consult result <job-id>
consult chain <job-id>
consult cancel <job-id>
```

Use `--resume` to continue the latest finalized Job for the selected Profile
in the current Host Session, `--resume-job <id>` for an explicit prior Job, or
`--fresh` to start over. Confined Codex/Claude Jobs archive only the completed
Session transcript and restore that one hash-verified file into the next fresh
Job home. Missing or incompatible state fails before creating a resume Job;
confined resume with `--isolated` is currently unsupported because its
Execution Workspace cwd changes. Resume is useful for a follow-up turn;
Consult intentionally does not attempt to transfer native conversation state
between unrelated agent CLIs.

All machine-readable Job outputs use a versioned envelope:

```json
{
  "schemaVersion": 1,
  "job": {},
  "outcome": {},
  "artifacts": {},
  "lineage": {}
}
```

Use `--json` with `delegate`, `review`, `status`, `result`, `logs`, `chain`,
`doctor`, `agents`, `setup`, and `brokers` when another agent or script will
parse the response. `outcome.finalText` contains agent message text rather
than rendered tool-call markers.

## Host Detection

Consult resolves Host Identity in this order:

1. `--host` and `--host-session` flags.
2. `CONSULT_HOST` and `CONSULT_HOST_SESSION_ID`.
3. `CODEX_THREAD_ID` for Codex, or `OPENCODE_SESSION_ID` /
   `OPENCODE_RUN_ID` for opencode.
4. `terminal/default`.

Claude Code is not auto-detected. A Claude spawning Host should pass
`--host claude-code --host-session <stable-session-id>` or set
`CONSULT_HOST` / `CONSULT_HOST_SESSION_ID`; otherwise its Jobs use the shared
`terminal/default` scope.

Host Identity scopes defaults, resume lookup, lineage, and lifecycle metadata.
The same `consult` CLI is the product interface from every Host.

## State and Troubleshooting

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
rerun `consult setup` so Consult can verify it.

## Agent Skills

The repository ships the generic `$consult` skill and convenience skills for
asking Claude, Codex, and opencode under [skills/](skills/). The tracked
[.opencode/skills/consult](.opencode/skills/consult) symlink exposes the generic
skill to opencode from a checkout. Other Hosts can copy or symlink the desired
skill directory into their own skill location.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run pack:check
```

Use `bun run test`, not `bun test`: the suite intentionally runs with Node's
test runner. Source is erasable TypeScript run directly by Node from a checkout.
Published packages contain compiled `.mjs` because Node does not type-strip
TypeScript under `node_modules`. The package smoke also starts an installed
background Job so source-only worker or Broker paths cannot pass on `help`
alone. Set `CONSULT_PACKAGE_SMOKE_CONFINED=1` on native Linux or macOS to run
the packed Codex/Claude registry-identity matrix for filesystem, egress,
write/isolation, background, cancellation, resume, credential staging, and
cleanup boundaries.

Architecture vocabulary is in [CONTEXT.md](CONTEXT.md), current implementation
notes are in [docs/PLAN.md](docs/PLAN.md), and accepted decisions are in
[docs/adr/](docs/adr/).

## License

Consult is licensed under the terms in [LICENSE](LICENSE).
