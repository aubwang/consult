# Consult

## What is Consult?

Call in support from a different coding agent.

It lets the tool you are already using, such as Claude Code, Codex, Opencode,
or a terminal, delegate a prompt to another AI agent such as
Claude, Codex, opencode, or GitHub Copilot, using ACP.

Each delegated prompt becomes a Job. Consult starts a job-scoped Broker for
that Job, streams the Profile's work, stores the final output, and gives you
commands to inspect, cancel, resume, or chain follow-up work.

Use Consult when you want another agent to inspect code, debug a failure, write
a small patch, add a focused test, review a diff, or keep working in the
background while you stay in your current Host.

## The 10-minute demo

1. Clone the repo and enter it:

   ```sh
   git clone https://github.com/aubwang/consult.git
   cd consult
   ```

2. Install dependencies and expose the local CLI:

   ```sh
   npm install
   npm link
   ```

   This repo is not published as an npm package. `npm link` exposes the local
   `consult` binary from this checkout.

3. Set up at least one Profile:

   ```sh
   consult setup
   ```

   From Claude Code, use the plugin command instead:

   ```text
   /consult:setup
   ```

   Setup checks the registry, offers install/default actions, runs an ACP
   initialize probe, and writes a Profile only after verification succeeds.

4. See the configured Profiles:

   ```sh
   consult agents
   ```

   To choose a default Profile:

   ```sh
   consult agents --set claude
   ```

5. Ask another agent to inspect the workspace without editing:

   ```sh
   consult delegate --agent claude --read-only -- "trace where cancellation is handled"
   ```

6. Let another agent edit inside the workspace:

   ```sh
   consult delegate --agent codex --write -- "add a regression test for broker cleanup"
   ```

7. Start a background Job:

   ```sh
   consult delegate --agent opencode --write --background -- "try a minimal fix for the flaky test"
   ```

   Then wait for it and print the stored result:

   ```sh
   consult status <job-id> --wait
   consult result <job-id>
   ```

8. Use the same command from Codex without losing Codex Host identity:

   ```sh
   consult delegate --agent claude --read-only -- "review the current diff"
   ```

9. Use the same command from opencode without losing opencode Host identity:

   ```sh
   consult delegate --agent codex --read-only -- "check this implementation"
   ```

10. If a Job gets stuck or a Broker locator looks stale, inspect Broker state:

    ```sh
    consult brokers
    consult brokers --cleanup
    ```

## Core concepts

| Term | Meaning |
| --- | --- |
| Host | The environment where delegation starts: Claude Code, Codex, opencode, or a terminal. |
| Profile | The ACP backend Consult calls, such as `claude`, `codex`, `opencode`, or `copilot`. |
| Job | One delegated prompt turn with status, logs, result text, and cancellation state. |
| Broker | A short-lived Consult-owned process that connects one Job to one Profile. |

If you run `consult delegate --agent claude ...` from Codex, Codex is the Host,
Claude is the Profile, and the delegated prompt is the Job. The same command
from opencode records opencode as the Host.

## Commands

CLI:

```sh
consult setup
consult agents
consult delegate --agent claude --read-only -- "explain this module"
consult status
consult result <job-id>
consult cancel <job-id>
consult brokers
```

Claude Code plugin commands:

```text
/consult:setup
/consult:agents
/consult:delegate --agent codex --write "add a focused test"
/consult:status
/consult:result <job-id>
/consult:cancel <job-id>
/consult:brokers
```

The same `consult` binary is used from terminal, Codex, and opencode. Consult
autodetects Codex, opencode, and Claude Code Host identity from the environment;
explicit `--host` / `--host-session` flags remain available for smoke tests and
manual overrides.

There is also a Codex-only review proxy:

```text
/consult:review
```

## Permission modes and sandboxing

Consult defaults delegated work to read-only unless a command or user explicitly
asks for write access.

| Mode | Behavior |
| --- | --- |
| `--read-only` | Delegated work may inspect files but must not edit. |
| `--write` | Delegated work may edit files inside the current workspace. |

Consult enforces workspace boundaries for ACP permission requests and for its
client-side file handlers. Symlink escapes are rejected by resolving real paths
before access is allowed.

Network fetch requests and raw execute requests are denied in both modes. `cwd`
checks alone are not enough to make arbitrary commands or outbound requests a
safe delegated surface.

Some Profiles report edits after they happen. Consult has a Broker-side
backstop for that path: if a Profile auto-approves an edit in read-only mode,
or touches a path outside the workspace, the Job fails. For Profiles that
report after writing, this is defense-in-depth rather than a hard filesystem
boundary.

For a stronger boundary, opt into bubblewrap:

```sh
CONSULT_AGENT_SANDBOX=bwrap consult delegate --agent claude --read-only -- "inspect this module"
```

In bubblewrap mode, read-only Jobs mount the workspace read-only, and write
Jobs mount the workspace as the only writable project path. Profile-specific
auth/config mounts are documented in the conformance reports.

## Profile status

Consult is pre-release, but the implemented local Profile set is usable.

| Profile | Status |
| --- | --- |
| `codex` | Supported. Direct, Consult, and bubblewrap sandbox probes pass. |
| `claude` | Supported. Direct, Consult, and bubblewrap sandbox probes pass. |
| `opencode` | Supported with provider auth configured. Direct, Consult, and bubblewrap sandbox probes pass. |
| `copilot` | Supported unsandboxed. Bubblewrap sandbox verification is still deferred. |

See [docs/conformance/README.md](docs/conformance/README.md) for the live
conformance matrix and Profile-specific notes.

## Required environment variables

Consult does not require environment variables for normal terminal use after
Profile setup. Host Adapters and optional sandboxing use these variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CONSULT_DATA_DIR` | No | `~/.consult` | Global Consult data root. Stores Profiles and per-workspace Job state. |
| `CONSULT_HOST` | No | autodetected, then `terminal` | Explicit Host name override. |
| `CONSULT_HOST_SESSION_ID` | No | autodetected, then `default` | Explicit Host Session id override. |
| `CONSULT_AGENT_SANDBOX` | No | `off` | Set to `bwrap` to launch ACP agents through bubblewrap. |
| `CONSULT_BROKER_IDLE_TIMEOUT_MS` | No | `1800000` | Idle Broker shutdown timeout. |
| `CONSULT_AVAILABLE_COMMANDS_TIMEOUT_MS` | No | `2000` | Timeout used by the Codex review proxy when checking available commands. |

Known Host session variables are detected in this order:

- `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` -> `opencode`
- `CODEX_THREAD_ID` -> `codex`
- `CLAUDE_SESSION_ID` -> `claude-code`

Global Profile config lives at:

```text
~/.consult/profiles.json
```

Per-workspace Job state lives under:

```text
~/.consult/workspaces/<sha256-of-repo-root>/
```

That workspace directory stores Job records, logs, Broker endpoint files,
Broker pidfiles, and optional workspace default Profile overrides.

## Agent skills

Tracked skills live in [skills/](skills/). They provide short delegation
entrypoints through the `consult` CLI:

```text
$consult:ask-claude
$consult:ask-codex
$consult:ask-opencode
$consult:ask-copilot
```

They default to read-only delegation and preserve user-supplied options such as
`--model` and `--effort`.

The tracked [.opencode/skills/consult](.opencode/skills/consult)
symlink makes the generic Consult skill visible to opencode from this checkout.
Generated `.opencode` dependency and config files are local state and ignored.

## Architecture and deeper docs

Read [CONTEXT.md](CONTEXT.md) for domain language, [docs/PLAN.md](docs/PLAN.md)
for architecture notes, [docs/ROADMAP.md](docs/ROADMAP.md) for pre-release and
deferred work, and [docs/adr/](docs/adr/) for accepted shipped decisions.

Host Adapter notes:

- [docs/host-adapters/codex.md](docs/host-adapters/codex.md)
- [docs/host-adapters/opencode.md](docs/host-adapters/opencode.md)

## Troubleshooting

If `consult delegate` says no Profile is configured, run `consult setup` and
complete at least one Profile install or default selection.

If a Profile cannot authenticate, run that Profile's native login first, such
as `codex login`, `claude /login`, `opencode auth login`, or `copilot login`.
Then rerun `consult setup` so Consult verifies the Profile.

If a background Job appears stuck, run:

```sh
consult status <job-id>
consult brokers
```

If the Broker locator is stale:

```sh
consult brokers --cleanup
```

If a bubblewrap run cannot see Profile auth, check the Profile-specific
conformance notes before adding mounts. Consult intentionally keeps sandbox
mounts narrow.

## Development

Run the full test suite:

```sh
npm test
```

Useful focused checks:

```sh
node --test scripts/consult-broker.test.mjs
node --test scripts/lib/process-sandbox.test.mjs scripts/lib/acp-client.test.mjs
node --test scripts/lib/companion/delegate-core.test.mjs
```

Run the safe companion-disconnect drill:

```sh
npm run drill:companion-disconnect
```

## License

Consult is licensed under the terms in [LICENSE](LICENSE).
