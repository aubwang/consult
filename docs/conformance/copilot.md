# GitHub Copilot CLI ACP Conformance

> **Handshake-level report.** This page records the initial inherit-only
> integration pass. Copilot is inherit-only; nothing here is evidence of
> ADR-0027 native confinement. See
> [`README.md`](README.md#job-authority-confinement) and ADR-0038.

Date: 2026-08-17
Workspace under test: `/home/user/consult`
Backend: `@github/copilot` 1.0.80 (`copilot --acp`, native ACP server — no
shim)
Platform: Linux x64

## Summary

Fourth built-in Profile. The Copilot CLI serves ACP itself, so setup adopts or
installs one binary and smoke-verifies it directly. The environment used for
this pass had no Copilot subscription or token, so checks that need a live
model turn are recorded as AUTH-DEFERRED rather than PASS; everything
reachable without auth passed, including the fail-closed confined rejection.

## What passed

| Check | Outcome |
|---|---|
| `consult setup --install copilot` | **PASS** — adopted the `copilot` binary already on `PATH`, ran the ACP `initialize` smoke probe, persisted the profile, printed `verified copilot`. |
| Raw ACP `initialize` probe | **PASS** — responded in ~0.8s (well inside the 5s/10s timeouts) with `protocolVersion: 1`, `agentCapabilities.loadSession: true`, session capabilities `close`/`list` (no `resume`), and `authMethods` advertising `copilot login` instead of blocking on a TTY. |
| Unauthenticated doctor fails closed | **PASS** — `doctor --agent copilot --sandbox inherit` without any Copilot credential reports `canDelegate: no`, `requested: unready: inherited authority preflight failed: Authentication required`. Inherited preflight creates a throwaway session (no model prompt), so a logged-out Profile fails doctor and delegation preflight before any Job exists. |
| Default confined preflight fails closed | **PASS** — `doctor` exit 1 and `delegate --read-only` without `--sandbox inherit` both report `confined authority is unsupported for Profile registry identity 'copilot'` with the codex/claude-or-inherit remediation; no Job was created. |
| `--resume` rejected | **PASS** — `delegate --resume` with a prior copilot Session on record fails with `RESUME_UNSUPPORTED: … this agent persists tool approvals across sessions, so Consult rejects reopening them until that state is bounded`, before any agent spawn. Copilot advertises `loadSession: true`, and Consult deliberately does not take the `session/load` fallback for this Profile. |
| Model error cannot masquerade as success | **PASS** — with an unreachable `COPILOT_PROVIDER_*` BYOK endpoint, the turn streamed retry notices, ended in a plain `"Error: Could not connect …"` message chunk, and Copilot still stopped with `end_turn`; Consult finalized the Job as `failed` with `COPILOT_MODEL_ERROR` (before this guard, the same turn persisted as `completed`). |
| `--deny-tool` pins accepted in ACP mode | **PASS (launch-level)** — `copilot --acp --deny-tool=shell,write,web_fetch` initializes normally, and every Consult launch appends the Job-mode pins and clears ambient `COPILOT_ALLOW_ALL` (unit-tested in `process-sandbox.test.mts`). Copilot documents deny rules as overriding `--allow-all` and saved approvals; observing a live denied shell under a real login is auth-deferred. |

## Auth-deferred (need a Copilot login or token)

- Basic foreground delegate marker round-trip.
- `--read-only` cooperative edit denial and shell-tempting prompt behavior
  under a real model turn, including observing the `--deny-tool` pins deny a
  shell attempt live. Static evidence is favorable: the CLI's permission
  options use spec-standard `allow_once`/`allow_always`/`reject_once`/
  `reject_always` kinds, which Consult's option picker maps to allow/reject,
  and deny rules rank above `--allow-all` and saved approvals.
- `--write` in-workspace edit, and the out-of-workspace backstop
  (preventive vs. defense-in-depth classification). Note the generic backstop
  inspects only `edit`-kind updates and explicit `auto_approved` markers, so
  for copilot the launch-level `--deny-tool` pins are the load-bearing
  control against unprompted shell/fetch tool calls.
- `--background` + `result` round-trip.

These must pass live before any confined-support follow-up (see ADR-0038).
Session reopening (`--resume`, `session/load`) is rejected by policy — see
above — so it is not on the auth-deferred list.

## Open follow-ups

- Rerun the auth-deferred rows in an environment with Copilot access and
  upgrade this page to a full pass.
- The legacy `CONSULT_AGENT_SANDBOX=bwrap` path mounts no Copilot config and
  is untested for this Profile (same status as opencode).
