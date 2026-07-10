---
name: consult-runtime
description: Internal contract for the Consult CLI and Broker handoff.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult Runtime

The public entrypoint is `consult <subcommand> ...`.

- `setup`: list, install, and select configured Profiles.
- `agents`: list configured Profiles available in this Workspace.
- `delegate`: create a Job and run one prompt turn inline or through a scoped Broker.
- `doctor`: diagnose profile, Host Identity, Job, Broker, and sandbox readiness for the current Workspace.
- `status`: show queued, running, completed, cancelled, or failed Job state.
- `result`: render a completed Job result and metadata.
- `logs`: print or follow rendered logs for one Job.
- `chain`: show the Delegation Chain rollup for one Job.
- `cancel`: cancel a queued or running Job.
- `brokers`: inspect live Broker locators and clean stale Broker state.
- `review`: run a pinned, Profile-neutral review Job; Codex may use its native adapter.
- `task-worker`: detached background worker entrypoint.
- `task-resume-candidate`: resolve the latest resumable Job for a Host Session, Profile, and Workspace.

The `consult` CLI resolves Host identity from explicit flags, explicit
`CONSULT_HOST` / `CONSULT_HOST_SESSION_ID` environment variables, or known Host
session variables such as `OPENCODE_SESSION_ID`, `OPENCODE_RUN_ID`,
and `CODEX_THREAD_ID`.

Jobs move through `queued -> running -> completed`, `cancelled`, or `failed`. Job records live under `workspaces/<hash>/jobs/`.

Logs are NDJSON files at `workspaces/<hash>/logs/<id>.log`.

Foreground Jobs run inline. A normal background Job may use a separate daemon
for one active Job; it exits after that Job finalizes. Isolated background Jobs
may run inline inside their detached worker.

Broker scope is one Broker per running Job.

Machine-readable Job output uses schema version 1 with `job`, `outcome`,
`artifacts`, and `lineage` sections. Internal Job records are not a public API.

`--write --isolated` runs the Profile in a detached Execution Workspace and
returns an agent-only patch plus touched-files manifest. `--allow-exec` grants
no authority unless it is explicit on an isolated write Job under an active
`bwrap` sandbox.
