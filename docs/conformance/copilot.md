# GitHub Copilot CLI ACP Conformance

Date: 2026-05-22
Workspace under test: local Consult checkout
Backend: `@github/copilot` + `--acp` headless mode

## Summary

Copilot is now live-verified for unsandboxed Consult delegation. The earlier
auth blocker was environmental: the old token path worked for general `gh` auth
but not Copilot Requests. In the passing test environment, the installed Copilot
CLI had a working Copilot-capable credential, direct non-interactive prompts
passed, and Consult could delegate to the `copilot` Profile over ACP.

Copilot `CONSULT_AGENT_SANDBOX=bwrap` behavior is still not live-verified. Do
not add Copilot-specific sandbox mounts until a Linux/bubblewrap comparison can
be run against a working unsandboxed path.

## What passed

| Check | Outcome |
|---|---|
| `copilot --acp` initialize | **PASS** — raw ACP initialize returned protocol version 1, `agentInfo.name: "Copilot"`, version `1.0.51`, and `agentCapabilities.loadSession: true`. |
| `/consult:setup --install copilot` | **PASS** — `npm install -g @github/copilot` installed/found `copilot`, the ACP initialize smoke probe passed, and the Profile was persisted in `~/.consult/profiles.json`. |
| Direct Copilot prompt | **PASS** — `copilot -p "respond with exactly: ok-copilot-direct-20260522" --allow-all-tools --silent` returned `ok-copilot-direct-20260522`. |
| Codex Host autodetection to Copilot Profile | **PASS** — `consult delegate --agent copilot --read-only --json -- "respond with exactly: ok-codex-to-copilot-rerun-20260522"` returned `ok-codex-to-copilot-rerun-20260522` with Job `job-dGx0SiQskU_k`. |
| `delegate --background` + `result` round-trip | **PASS** — background Job `job-OQ44QDBM-c8-` completed and `consult result job-OQ44QDBM-c8-` returned `ok-codex-to-copilot-bg-20260522`. |

## Not run live

- Read-only edit denial, write-mode in-workspace edits, write-mode
  out-of-workspace backstop, and cancel. These remain covered by the
  backend-neutral unit/integration suite and should be exercised in a fuller
  Copilot conformance pass before claiming parity with codex/claude/opencode.
- `--resume`: the current Copilot ACP initialize response advertises
  `loadSession: true` but no `sessionCapabilities.resume`; Consult can use the
  backend-neutral load fallback if `--resume` is explicitly tested later.
- `CONSULT_AGENT_SANDBOX=bwrap`: deferred until a Linux/bubblewrap environment
  with this Copilot auth is available.

## 2026-05-24 sandbox verification attempt

Environment check:

- `/usr/bin/bwrap` is available.
- `copilot` is available on PATH and reports GitHub Copilot CLI 1.0.48.
- The `copilot` Profile exists in `~/.consult/profiles.json`.

Direct Copilot baseline did not pass in this session:

| Check | Outcome |
|---|---|
| `copilot -p "respond with exactly: ok-copilot-direct-20260524" --allow-all-tools --silent` | **FAIL (no auth in shell)** — Copilot reported no authentication information. |
| Same direct prompt after loading the available GitHub token into the shell | **FAIL (token lacks Copilot Requests access)** — Copilot rejected the token for Copilot Requests. |

Result: Copilot sandbox verification remains blocked on a Copilot-capable
credential. No Copilot-specific bwrap mounts were added because there is no
passing direct/unsandboxed baseline to compare against.

## Auth note

Copilot CLI accepts multiple auth paths. In the live proof, direct `copilot -p`
succeeded with an already-configured Copilot-capable credential. The Copilot CLI
help documents these supported token/env paths, in precedence order:
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`. Classic `ghp_` PATs are
not supported; use `copilot login`, a supported GitHub CLI OAuth token, or a
fine-grained token with Copilot Requests permission.

## Open follow-ups

1. Run a fuller Copilot conformance sweep for read-only/write/cancel behavior.
2. Verify Copilot sandbox behavior once the test environment has a
   Copilot-capable credential available to non-interactive shell sessions, then
   add any required Copilot-specific auth/config mounts.
