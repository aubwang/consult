# Consult Roadmap

This file tracks pre-release product direction for Consult.

## Current Status

The implemented local Profile set is usable:

- Host-neutral Consult Core path.
- Claude Code Host Adapter compatibility.
- Direct `consult` CLI.
- Codex Host autodetection through the single `consult` CLI.
- opencode Host autodetection through the single `consult` CLI.
- Idle Broker timeout fallback.
- Delegation Chains visibility and cancel behavior.
- Explicit Broker inspection/cleanup through `consult brokers`.
- Opt-in workspace filesystem sandboxing with `CONSULT_AGENT_SANDBOX=bwrap`.
- Profile-aware bwrap support for `claude`, `codex`, `opencode`, and `gemini`.
- Live conformance reports for `codex`, `claude`, `opencode`, and unsandboxed
  `copilot`.
- Unit-covered Gemini CLI Profile support using native ACP mode; live
  conformance is pending local Gemini auth.

## Verified Backends

Fresh release-readiness probes on 2026-05-19 passed:

- `claude`: direct Claude CLI, unsandboxed Consult delegate, and
  `CONSULT_AGENT_SANDBOX=bwrap` Consult delegate.
- `codex`: direct Codex CLI, unsandboxed Consult delegate, and
  `CONSULT_AGENT_SANDBOX=bwrap` Consult delegate.
- `opencode`: direct opencode CLI, unsandboxed Consult delegate, and
  `CONSULT_AGENT_SANDBOX=bwrap` Consult delegate.
- `copilot`: direct Copilot CLI, unsandboxed Consult delegate, and background
  Consult delegate/result.

## Sandbox-Deferred

`copilot` is supported for unsandboxed Consult delegation, but Copilot-specific
`CONSULT_AGENT_SANDBOX=bwrap` behavior remains deferred until a test environment
has a Copilot-capable credential available to non-interactive shell sessions. A
2026-05-24 retry found `bwrap` and the Copilot Profile present, but direct
Copilot prompts failed before sandbox comparison because the available GitHub
token was not accepted for Copilot Requests.

## v1 Hardening Notes

- `BROKER_BUSY` is the expected same-broker concurrency behavior, but Brokers
  are job-scoped. Separate Jobs in the same Host Session/Profile/Workspace can
  run concurrently in separate Broker/backend processes.
- Companion-disconnect-mid-prompt is covered by focused broker tests for both
  acknowledged and unacknowledged cancel paths. A safe process-level drill now
  exercises killing the real companion CLI against the fake ACP agent via
  `npm run drill:companion-disconnect`.
- Broker crash/error recovery is bounded for v1 by stale broker detection,
  teardown/respawn on next use, cancel-time unreachable handling, tainting after
  an unacknowledged disconnect cancel, and foreground delegate failure if the
  broker disconnects after accepting a job but before finalization.
- Claude cancel timing works within the documented budget. No safe low-risk
  protocol change is pending; do not free the work-plane mutex before the agent
  has acknowledged cancel or the broker has taken the taint/failure path.

## v1.x Follow-Ups

- Verify Copilot sandbox behavior in a Linux/bubblewrap environment and add any
  required Copilot-specific auth/config mounts.
- Improve broker crash/error messages further only if field usage shows the
  current cleanup hints are too opaque.
- Add richer Host Adapter integration only where it stays thin and optional.
