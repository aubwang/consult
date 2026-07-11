---
name: consult-runtime
description: Internal contract for the Consult CLI and Broker handoff.
metadata:
  "consult.disable-model-invocation": "true"
  internal: true
---

# Consult Runtime

The public entrypoint is `consult <subcommand> ...`.

- `setup`: list, install, and select configured Profiles.
- `agents`: list configured Profiles available in this Workspace.
- `delegate`: create a Job and run one prompt turn inline or through a scoped Broker.
- `doctor`: diagnose Profile, Host Identity, Job, Broker, and default Job
  Authority readiness for the current Workspace and Host context.
- `status`: show queued, running, completed, cancelled, failed, or skipped Job
  state.
- `wait`: block once for one or more terminal Job Results; interrupting it
  best-effort cancels still-active selected Jobs unless `--keep-running` is set.
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

Jobs move through `queued -> running -> completed`, `cancelled`, `failed`, or
`skipped`. Job records live under `workspaces/<hash>/jobs/`.

Repeatable `delegate --background --after <job-id>` dependencies wait for
existing same-Workspace Jobs. Completed prerequisite final text is appended in
declared order inside a bounded untrusted-data block. A failed, cancelled, or
skipped prerequisite skips the dependent Job without starting its Profile.
Dependencies do not imply lineage, authority inheritance, patch application,
or Session continuation.

Logs are NDJSON files at `workspaces/<hash>/logs/<id>.log`.

Foreground Jobs run inline. A normal background Job may use a separate daemon
for one active Job; it exits after that Job finalizes. Isolated background Jobs
may run inline inside their detached worker.

Broker scope is one Broker per running Job.

Machine-readable Job output uses schema version 1 with `job`, `outcome`,
`artifacts`, and `lineage` sections. Internal Job records are not a public API.

`--write --isolated` runs the Profile in a detached Execution Workspace and
returns an agent-only patch plus touched-files manifest.

Job Authority schema v1 contains mode (`read-only | write`), confinement
(`confined | inherit`), `allowFetch`, and `allowExecute`. The default is
read-only confined with both grants false. Built-in `codex` and `claude`
Profiles use Consult-managed native Linux and native arm64 macOS confinement,
a private Job home/temp directory, selected credentials only, direct-network
denial, and an authenticated model-host proxy. `--allow-fetch` broadens that proxy to public
TCP/443 (without TLS or application-protocol inspection) and therefore
increases credential/data exfiltration risk.

Consult does not broker the macOS Keychain. Confined Claude on macOS requires
`CONSULT_CLAUDE_API_KEY`, `CONSULT_CLAUDE_OAUTH_TOKEN`, or a stageable
`.claude/.credentials.json`; a Keychain-only login fails preflight.
`CONSULT_OPENAI_API_KEY` similarly overrides Codex `auth.json`. Consult-specific
credentials take precedence; ambient vendor variables do not. Consult does not
refresh vendor credentials.

Preflight initializes the exact configured Profile before Job persistence and
fails closed. Consult never changes a failed confined request to inheritance.
`--sandbox inherit` is an explicit trusted-Host choice that adds no Consult OS
boundary; custom and `opencode` Profiles require it. Confined nesting, native
Windows, and macOS x64 processes are unsupported. `--allow-exec` remains unavailable
pending execute resource containment and cross-Profile conformance. Wall-clock
and log limits ship, but process-count, CPU, memory, disk, and global fan-out
quotas do not; the Host must bound concurrent delegation.
