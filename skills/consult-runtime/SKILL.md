---
name: consult-runtime
description: Internal contract for the consult plugin's companion / broker handoff. Loaded by the delegate subagent for context.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult Runtime

The companion CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" <subcommand> ...`.

- `setup`: list, install, and select configured Profiles.
- `agents`: list configured Profiles available in this Workspace.
- `delegate`: create a Job and run one prompt turn through the scoped Broker.
- `status`: show queued, running, completed, cancelled, or failed Job state.
- `result`: render a completed Job result and metadata.
- `cancel`: cancel a queued or running Job.
- `brokers`: inspect live Broker locators and clean stale Broker state.
- `review`: run the Codex-only review adapter.
- `task-worker`: detached background worker entrypoint.
- `task-resume-candidate`: resolve the latest resumable Job for a Host Session, Profile, and Workspace.

The `consult` CLI resolves Host identity from explicit flags, explicit
`CONSULT_HOST` / `CONSULT_HOST_SESSION_ID` environment variables, or known Host
session variables such as `OPENCODE_SESSION_ID`, `OPENCODE_RUN_ID`,
`CODEX_THREAD_ID`, and `CLAUDE_SESSION_ID`. The Claude Code `SessionStart` hook
still writes explicit Consult Host identity into `$CLAUDE_ENV_FILE` so slash
commands have stable cleanup and resume scoping.

Jobs move through `queued -> running -> completed`, `cancelled`, or `failed`. Job records live under `workspaces/<hash>/jobs/`.

Logs are NDJSON files at `workspaces/<hash>/logs/<id>.log`.

The Broker is a separate daemon for one active Job. It exits after that Job finalizes.

Broker scope is one Broker per running Job.
