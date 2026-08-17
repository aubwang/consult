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
| `consult doctor --agent copilot --sandbox inherit` | **PASS** — exit 0, requested authority `ready`, with the standard inherit warning. |
| Default confined preflight fails closed | **PASS** — `doctor` exit 1 and `delegate --read-only` without `--sandbox inherit` both report `confined authority is unsupported for Profile registry identity 'copilot'` with the codex/claude-or-inherit remediation; no Job was created. |
| Unauthenticated turn fails fast | **PASS** — `delegate --agent copilot --read-only --sandbox inherit` finalized the Job as `failed` in under a second with `-32000: Authentication required`; no hang, no TTY prompt. Remediation is the registry `notes`: `copilot` + `/login`, or `COPILOT_GITHUB_TOKEN`. |

## Auth-deferred (need a Copilot login or token)

- Basic foreground delegate marker round-trip.
- `--read-only` cooperative edit denial and shell-tempting prompt behavior
  under a real model turn. Static evidence is favorable: the CLI's permission
  options use spec-standard `allow_once`/`allow_always`/`reject_once`/
  `reject_always` kinds, which Consult's option picker maps to allow/reject.
- `--write` in-workspace edit, and the out-of-workspace backstop
  (preventive vs. defense-in-depth classification).
- `--background` + `result` round-trip.
- `session/load` round-trip (`supports.load: true` mirrors the advertised
  capability but has not been exercised live). `--resume` is expected to be
  rejected as unsupported; resume is not advertised.

These must pass live before any confined-support follow-up (see ADR-0038).

## Open follow-ups

- Rerun the auth-deferred rows in an environment with Copilot access and
  upgrade this page to a full pass.
- The legacy `CONSULT_AGENT_SANDBOX=bwrap` path mounts no Copilot config and
  is untested for this Profile (same status as opencode).
