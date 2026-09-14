# ADR-0043: Bounded worker validation, Job batches, and the Pi harness

Status: Accepted

## Decision

Keep Consult CLI-only and Host-neutral. Add mechanisms that let a Host delegate
implementation with a local feedback loop and supervise independent work:

- `delegate --write --isolated --allow-exec` enables local commands for confined
  Codex and Claude Profiles on Linux. Explicit execute authority remains
  incompatible with fetch, inherited authority, and in-place writes.
- Execute launches enter a systemd user scope. A Consult-owned guard reads back
  cgroup v2 limits before starting the sandbox: 4 GiB memory, no swap, 256 tasks,
  and 200% CPU. The scope has a 30-minute lifetime and a two-second stop grace.
  `prlimit` imposes a 64 MiB per-file hard limit and disables core dumps.
  Initialization fails closed if these controls cannot be established. Scope
  termination precedes Session archival and filesystem cleanup, covering child
  processes that escape the original process group. Unconfirmed termination
  fails the Job and preserves its workspace without capturing unstable patch
  artifacts. These are per-Job bounds;
  total disk consumption and aggregate concurrency remain Host responsibilities.
- Execute Jobs copy eligible, ignored `node_modules` into their execution
  workspace with independent files, using reflinks when supported. Copies are
  limited to 1 GiB/100000 entries and reject absolute/external symlinks and
  special files. They do not install packages or run setup hooks. Already
  installed Node, npm, Bun, Python, uv, and Git executables are exposed through
  the private runtime path when available. Other environment provisioning is
  still explicit work for the Host.
- `batch <file>` validates 1-8 independent submissions, launches ordinary
  background Jobs, and journals their returned ids in a versioned receipt.
  Partial failures retain the submitted ids. Writers require explicit isolation.
  A batch is a submission aid, not another runtime, DAG, or workflow engine.
- `wait --batch`, `--active`, `--any`, `--watch`, and `--timeout` make supervision
  possible without repeated large status reads. Selection is a snapshot;
  `--any` reports the current state of all selected Jobs. Watch output goes to
  stderr; JSON stdout keeps the existing Job Result envelope.
- `help workflows` teaches bounded worker/test/reviewer patterns. The Host or
  Cruise still chooses policy, evaluates evidence, and applies patches.

## Pi

Add registry Profile `pi`, installing `@earendil-works/pi-coding-agent` and
launching the installed native harness through a thin internal RPC-to-ACP
bridge. No external pi-acp package, plugin, skill, or extra public executable
is needed. Pi >=0.84.4 is required for the verified protocol surface.

Pi uses explicit inherited authority. Consult disables extensions, skills,
prompt templates, and themes, disables startup networking/telemetry, and pins
its built-in tool allowlist to the Job mode. It does not grant bash. This is
cooperative tool policy, not OS confinement. Provider configuration and native
credentials stay with Pi. A cold prompt is prefixed to prevent interpretation
as a slash or bang command. Client MCP servers and non-text prompts are rejected.

The bridge supports streamed text and thinking, tool events, model and thinking
selection, cancel, and resume through persisted Pi Session files. Only
`agent_settled` completes a prompt: `agent_end` may precede retries and queued
continuations. Model errors and transport exits fail the Job. JSONL framing and
transport buffering are bounded, and notifications preserve order.

`PI_CODING_AGENT=true` identifies a Pi Host. Pi does not export a native Session
id, so the Host Session is `default` unless supplied through `CONSULT_*` or CLI
flags. There is no invented native Session identity or Host conversation fork.

## Consequences and verification

This supersedes the blanket execute-unavailable gate in ADR-0027 for the exact
supported Linux combination. Other platforms retain their existing read/write
confinement and reject execute. Pi confinement and cross-Host conversation
forking are not implied by this change.

Deterministic tests cover permission grants, isolated dependency snapshots,
batch validation and partial submission, wait semantics, and Pi lifecycle and
resume behavior. Opt-in native tests (`CONSULT_TEST_EXECUTION=1` and
`CONSULT_TEST_PI=1`) exercise actual cgroup/kernel controls, both confined
Profile identities with a synthetic ACP agent, and installed Pi against a local
synthetic model that attempts both allowed and disabled tools. These controls
exercise the transport and enforcement boundaries without using vendor credits
or sending project data to a model service.
