# Consult

Consult lets you ask another coding agent for help without leaving the tool you
are already using.

You can start in Claude Code, Codex, opencode, or a plain terminal, then
delegate a prompt to a configured Profile such as Claude, Codex, opencode, or
GitHub Copilot. Consult tracks that work as a Job, streams progress, stores the
final result, and lets you check, cancel, or continue it later.

Use it when you want a second agent to:

- inspect unfamiliar code
- debug a failure
- write or review a small change
- add a focused test
- try an alternate implementation path
- keep working in the background while you stay in your current Host

## Quick Start

Install this checkout and expose the local CLIs:

```sh
npm install
npm link
```

Set up at least one Profile:

```sh
consult setup
```

If you are in Claude Code, use the slash command instead:

```text
/consult:setup
```

Then delegate some work:

```sh
consult delegate --agent claude --read-only -- "trace where cancellation is handled"
```

Or, from Claude Code:

```text
/consult:delegate --agent codex --write "add a regression test for the broker cleanup case"
```

Or, from Codex:

```sh
consult-codex delegate --agent claude --read-only -- "review the current diff for missed tests"
```

That is the core loop: set up Profiles, delegate a prompt, watch the Job, read
the result.

## The Mental Model

Consult uses four names:

| Term | Meaning |
| --- | --- |
| Host | The tool you are currently using: Claude Code, Codex, opencode, or a terminal. |
| Profile | The agent Consult calls on your behalf, such as `claude`, `codex`, `opencode`, or `copilot`. |
| Job | One delegated prompt turn, with status, logs, output, and cancellation state. |
| Broker | The short-lived process that connects Consult to the Profile for a Job. |

So if you run `consult-codex delegate --agent claude ...`, Codex is the Host,
Claude is the Profile, and the delegated prompt is a Job.

## Common Workflows

Ask another agent for an answer now:

```sh
consult delegate --agent claude --read-only -- "explain how profile setup works"
```

Let another agent edit inside the current workspace:

```sh
consult delegate --agent codex --write -- "add coverage for failed broker reconnects"
```

Start work in the background:

```sh
consult delegate --agent opencode --write --background -- "try a minimal fix for the flaky test"
```

Then check it and read the result:

```sh
consult status <job-id> --wait
consult result <job-id>
```

Cancel a running Job:

```sh
consult cancel <job-id>
```

Continue related work from a parent Job:

```sh
consult delegate --parent-job <job-id> -- "continue from the previous result"
```

Child Jobs inherit the parent permission ceiling. A child of a read-only Job
cannot be upgraded to `--write`.

## Commands

These are the commands most users need:

| Command | Purpose |
| --- | --- |
| `consult setup` | Install, verify, and select Profiles. |
| `consult agents` | List Profiles and set defaults. |
| `consult delegate` | Send work to a configured Profile. |
| `consult status` | Show Job state. |
| `consult result` | Print stored Job output. |
| `consult cancel` | Cancel an active Job. |
| `consult brokers` | Inspect Broker state and clean up stale Broker locators. |

Claude Code exposes the same core flow as slash commands:

```text
/consult:setup
/consult:agents
/consult:delegate
/consult:status
/consult:result
/consult:cancel
/consult:brokers
```

There is also a Codex-only review proxy:

```text
/consult:review
```

## Install Details

Consult is currently distributed as a plugin checkout, not as a published npm
package. `npm install` installs JavaScript dependencies, and `npm link` exposes
the local binaries:

```sh
consult
consult-codex
consult-opencode
```

For Claude Code, install this repository through Claude Code's plugin mechanism.
The plugin manifest lives at [.claude-plugin/plugin.json](.claude-plugin/plugin.json).

Profile setup is separate from plugin installation. Run `consult setup` or
`/consult:setup` after installing the checkout. Setup checks the registry,
offers install/default-model actions, runs an ACP initialize probe, and writes a
Profile only after verification succeeds.

## Host Adapters

The direct CLI works from any shell:

```sh
consult delegate --agent claude --write -- "implement the small parser fix"
```

The Codex wrapper supplies Codex Host identity before calling the same Consult
core:

```sh
consult-codex delegate --agent claude --read-only -- "trace this failure"
consult-codex status
consult-codex result <job-id>
consult-codex cancel <job-id>
```

The opencode wrapper does the same for opencode:

```sh
consult-opencode delegate --agent codex --read-only -- "check this implementation"
consult-opencode status
consult-opencode result <job-id>
consult-opencode cancel <job-id>
```

## Profile Status

Consult is pre-release, but the implemented local Profile set is usable.

| Profile | Current status |
| --- | --- |
| `codex` | Supported. Direct, Consult, and bubblewrap sandbox probes pass. |
| `claude` | Supported. Direct, Consult, and bubblewrap sandbox probes pass. |
| `opencode` | Supported with provider auth configured. Direct, Consult, and bubblewrap sandbox probes pass. |
| `copilot` | Supported unsandboxed. Bubblewrap sandbox verification is still deferred. |

See [docs/conformance/README.md](docs/conformance/README.md) for the live
conformance matrix and Profile-specific notes.

## Safety

Consult has two main permission modes:

| Mode | Behavior |
| --- | --- |
| `--read-only` | Delegated work may inspect files but must not edit. |
| `--write` | Delegated work may edit files inside the current workspace. |

Consult checks workspace boundaries for ACP permission requests and for its
client-side file handlers. Symlink escapes are rejected by resolving real paths
before access is allowed.

Some Profiles report edits after they happen. Consult has a Broker-side
backstop for that path: if a Profile auto-approves an edit in read-only mode, or
touches a path outside the workspace, the Job fails. For Profiles that report
after writing, this is defense-in-depth rather than a hard filesystem boundary.

For a stronger boundary, opt into bubblewrap:

```sh
CONSULT_AGENT_SANDBOX=bwrap consult delegate --agent claude --read-only -- "inspect this module"
```

In bubblewrap mode, read-only Jobs mount the workspace read-only, and write Jobs
mount the workspace as the only writable project path. See the conformance docs
for Profile-specific auth and config mount details.

## State

Global Profile configuration lives here:

```text
~/.consult/profiles.json
```

Per-workspace Job state lives under:

```text
~/.consult/workspaces/<sha256-of-repo-root>/
```

That workspace directory stores Job records, logs, Broker endpoint files,
Broker pidfiles, and optional workspace default Profile overrides.

## Codex Supporter Skills

This repo also ships Codex skills for quick delegation through `consult-codex`.
They default to read-only delegation and preserve options such as `--model` and
`--effort`:

```text
$consult:ask-claude
$consult:ask-codex
$consult:ask-opencode
$consult:ask-copilot
```

Tracked skill source lives in [skills/](skills/). Local installed agent state is
kept out of the repo.

## Development

Run the full test suite:

```sh
npm test
```

Useful focused checks:

```sh
node --test scripts/consult-broker.test.mjs
node --test scripts/lib/broker-client.test.mjs scripts/lib/companion/delegate-core.test.mjs
node --test scripts/lib/process-sandbox.test.mjs scripts/lib/acp-client.test.mjs
```

Project docs:

- [CONTEXT.md](CONTEXT.md) defines the domain language.
- [docs/PLAN.md](docs/PLAN.md) has durable architecture notes.
- [docs/ROADMAP.md](docs/ROADMAP.md) tracks pre-release and deferred work.
- [docs/adr/](docs/adr/) records accepted shipped decisions.
- [docs/conformance/README.md](docs/conformance/README.md) tracks live Profile conformance.

## License

Consult is licensed under the terms in [LICENSE](LICENSE).
