---
name: consult
description: Use Consult delegation commands such as delegate, status, result, cancel, agents, setup, or brokers from any Host. The consult CLI autodetects Codex, opencode, and Claude Code Host identity from the environment.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult

Use this skill to invoke Consult through the single `consult` CLI. Do not use
Host-specific wrapper commands.

## Host Identity

Run Consult commands directly:

```sh
consult <command> ...
```

The CLI resolves Host identity in this order:

1. Explicit `--host` / `--host-session` flags.
2. `CONSULT_HOST` / `CONSULT_HOST_SESSION_ID` environment variables.
3. Known Host session variables:
   - `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` -> `opencode`
   - `CODEX_THREAD_ID` -> `codex`
   - `CLAUDE_SESSION_ID` -> `claude-code`
4. `terminal/default`.

## Commands

Supported first:

- `delegate`: delegate a prompt to the selected Profile.
- `status`: show all Jobs in the Workspace or one Job by id.
- `result`: show the final stored output for a completed Job.
- `cancel`: cancel a queued or running Job.
- `agents`: list or set configured Profiles.
- `setup`: install or verify Profiles.
- `brokers`: inspect live Broker locators and clean stale Broker state.

Examples:

```sh
consult delegate --agent claude --read-only -- "review this diff"
consult delegate --agent opencode --read-only -- "summarize this repo"
consult delegate --agent gemini --read-only -- "look for missed edge cases"
consult status
consult result job-id
consult cancel job-id
```

Forward user arguments directly to `consult`. Do not inspect
`~/.consult/workspaces`, job JSON, broker endpoint files, or modules under
`scripts/lib`; the CLI is the adapter boundary.

## Manual Setup

Until an installer exists:

1. Put the Consult CLI on `PATH`, for example by running `npm link` from the
   Consult repo or by adding the repo's `bin` directory to `PATH`.
2. Make this skill visible to the Host by copying or symlinking `skills/consult`
   into the Host's skill directory.
3. Configure Profiles with the Consult CLI before first delegation, for example:

```sh
consult setup
consult setup --install codex
consult agents --set codex --host codex
```
