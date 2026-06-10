# Consult

Call in support from another coding agent without leaving the tool you are
already using.

## In Action

```text
$ consult delegate --agent claude --read-only -- "review this diff for bugs"
Host: codex
Profile: claude
Job: job-8tY...

Claude:
- scripts/lib/host-identity.mjs: the fallback path loses the Host session id
  when only CODEX_THREAD_ID is present.
- Add a resolver test before changing the CLI surface.

$ consult delegate --agent opencode --write --background -- "add that test"
queued job-R4x...

$ consult status job-R4x --wait
job-R4x completed

$ consult result job-R4x
Added the regression test and verified the focused suite.
```

The same `consult` command works from a terminal, Codex, opencode, and Claude
Code. It autodetects the calling **Host** and delegates to the **Profile** you
choose with `--agent`.

## Why Consult?

Coding agents have different strengths. Consult lets your current agent ask
another agent to review a change, debug a failure, inspect a design, or make a
small patch.

Each delegated prompt becomes a **Job**. Consult starts a short-lived
job-scoped **Broker**, streams the Profile's work, stores the final output, and
gives you commands to check status, cancel, resume, and read results.

## Install

This repo is currently a local package, not a published package:

```sh
git clone https://github.com/aubwang/consult.git
cd consult
bun install
bun link
```

`bun link` registers this checkout and installs the `consult` binary into
Bun's global bin directory (`~/.bun/bin`). Node.js >= 24 is still required at
runtime; `npm install` and `npm link` also work if you prefer npm.

## First Setup

Install or verify at least one Profile:

```sh
consult setup
```

Then choose a default Profile if you want one:

```sh
consult agents
consult agents --set claude
```

From Claude Code, use the plugin commands instead:

```text
/consult:setup
/consult:agents
```

## Everyday Use

Ask another agent to inspect without editing:

```sh
consult delegate --agent claude --read-only -- "trace where cancellation is handled"
```

Let another agent edit inside the workspace:

```sh
consult delegate --agent codex --write -- "add a regression test for broker cleanup"
```

Run work in the background:

```sh
consult delegate --agent opencode --write --background -- "try a minimal fix"
consult status <job-id> --wait
consult result <job-id>
```

Cancel or clean up:

```sh
consult cancel <job-id>
consult brokers
consult brokers --cleanup
```

Claude Code plugin equivalents:

```text
/consult:delegate --agent codex --write "add a focused test"
/consult:status <job-id>
/consult:result <job-id>
/consult:cancel <job-id>
```

## The Mental Model

| Term | Meaning |
| --- | --- |
| Host | Where the request starts: terminal, Codex, opencode, or Claude Code. |
| Profile | The agent Consult calls: `claude`, `codex`, `opencode`, `gemini`, or `copilot`. |
| Job | One delegated prompt turn with status, logs, and stored result text. |
| Broker | The short-lived Consult process that connects one Job to one Profile. |

Example:

```sh
consult delegate --agent claude --read-only -- "review this diff"
```

If you run that from Codex, Codex is the Host and Claude is the Profile. If you
run the same command from opencode, opencode is the Host and Claude is still the
Profile.

## Host Detection

Explicit flags and env vars win:

```sh
consult delegate --host codex --host-session smoke-test --agent claude -- "hello"
```

Otherwise Consult detects common Host session variables:

| Signal | Host |
| --- | --- |
| `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` | `opencode` |
| `CODEX_THREAD_ID` | `codex` |
| `CLAUDE_SESSION_ID` | `claude-code` |
| none | `terminal/default` |

## Safety

Consult defaults delegated work to read-only unless you explicitly ask for
write access.

| Mode | Behavior |
| --- | --- |
| `--read-only` | The Profile may inspect files but must not edit. |
| `--write` | The Profile may edit files inside the current workspace. |

Consult confines ACP file handlers to the workspace and rejects symlink escapes.
Network fetch requests and raw execute requests are denied in both modes.

Some Profiles report edits after they happen. Consult still marks read-only or
out-of-workspace edits as failed, but that is defense-in-depth, not a hard
filesystem boundary. For a stronger boundary, use bubblewrap:

```sh
CONSULT_AGENT_SANDBOX=bwrap consult delegate --agent claude --read-only -- "inspect this module"
```

## Supported Profiles

| Profile | Notes |
| --- | --- |
| `claude` | Supported. Direct, Consult, and bubblewrap probes pass. |
| `codex` | Supported. Direct, Consult, and bubblewrap probes pass. |
| `opencode` | Supported with provider auth configured. |
| `gemini` | Supported via Gemini CLI's native ACP mode. |
| `copilot` | Supported unsandboxed; bubblewrap verification is deferred. |

See [docs/conformance/README.md](docs/conformance/README.md) for the live
conformance matrix and Profile-specific notes.

## Files and State

Global Profile config:

```text
~/.consult/profiles.json
```

Per-workspace Job state:

```text
~/.consult/workspaces/<sha256-of-repo-root>/
```

That workspace directory stores Job records, logs, Broker endpoint files,
Broker pidfiles, and optional workspace default Profile overrides.

## Skills

Tracked skills live in [skills/](skills/):

```text
$consult
$consult:ask-claude
$consult:ask-codex
$consult:ask-opencode
$consult:ask-gemini
$consult:ask-copilot
```

The tracked [.opencode/skills/consult](.opencode/skills/consult) symlink makes
the generic Consult skill visible to opencode from this checkout.

## Troubleshooting

If `consult delegate` says no Profile is configured, run:

```sh
consult setup
```

If a Profile cannot authenticate, run that Profile's native login first, such
as `codex login`, `claude /login`, `opencode auth login`, `gemini`, or
`copilot login`. Then rerun `consult setup` so Consult verifies the Profile.

If a background Job appears stuck:

```sh
consult status <job-id>
consult brokers
consult brokers --cleanup
```

## Deeper Docs

- [CONTEXT.md](CONTEXT.md) defines the product vocabulary.
- [docs/PLAN.md](docs/PLAN.md) explains the architecture.
- [docs/ROADMAP.md](docs/ROADMAP.md) tracks pre-release direction.
- [docs/adr/](docs/adr/) records accepted decisions.
- [docs/host-adapters/codex.md](docs/host-adapters/codex.md) documents Codex Host detection.
- [docs/host-adapters/opencode.md](docs/host-adapters/opencode.md) documents opencode Host detection.

## Development

```sh
bun run typecheck
bun run test
```

Use `bun run test` (the package script, which runs `node --test`), not
`bun test` — `bun test` invokes Bun's own test runner and does not run this
suite.

The source is TypeScript (`.mts`) executed directly by Node's native type
stripping — there is no build step. `bun run typecheck` runs `tsc --noEmit`.

Useful focused checks:

```sh
node --test scripts/consult-broker.test.mts
node --test scripts/lib/process-sandbox.test.mts scripts/lib/acp-client.test.mts
node --test scripts/lib/companion/delegate-core.test.mts
```

Run the safe companion-disconnect drill:

```sh
bun run drill:companion-disconnect
```

## License

Consult is licensed under the terms in [LICENSE](LICENSE).
