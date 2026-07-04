# OpenCode ACP Conformance

Date: 2026-05-15
Workspace under test: `/tmp/iter18-oc-sweep`
Backend: `opencode` v1.14.41 + the `acp` subcommand
LLM provider: OpenRouter (`OPENROUTER_API_KEY` supplied at runtime)
Plugin commit at test time: `27306d7`

## Summary

Third backend conformance-tested live in this repo. The earlier iter-1 pass had failed because the codex-rescue sandbox couldn't bind Unix sockets and couldn't pull provider credentials, plus the `setup --install` short-circuit hadn't yet landed. With the credentials set via env var and the broker fixes in place, opencode now passes the core conformance checks. This report replaces the iter-1 transcript.

## What passed

| Check | Outcome |
|---|---|
| `/consult:setup --install opencode` | **PASS** — the iter-2 short-circuit (commit `abb5b9f`) detects opencode already on `PATH`, skips the redundant `npm install -g`, runs the smoke probe, and persists the profile. |
| Basic foreground delegate | **PASS** — `delegate --agent opencode "respond with exactly: opencode-alive"` returned `opencode-alive`. |
| `delegate --write` in-workspace edit | **PASS** — `o.txt` created with the requested content. |
| `delegate --read-only` rejects edit | **PASS** — job marked `failed`, attempted file `blocked.txt` not created. Opencode routes the edit through `session/request_permission`; the consult plugin's read-only policy denies. |
| `delegate --write` outside workspace | **PASS (defense-in-depth)** — job marked `failed` with the policy violation message; HOWEVER the target file `/tmp/iter18-outside.txt` was still written to disk before opencode reported the tool call. Same caveat as codex: this backend writes before reporting. The plugin still gives the user a clear failure signal and prevents the job from being treated as successful. A workspace-level fs sandbox would be the only hard boundary. |
| `delegate --background` + `result` round-trip | **PASS** — background job queued, `result <id>` returned `bg-done`. |

## Not run live

- `cancel` mid-prompt (covered by unit tests; comparable to codex/claude — likely PASS).
- `--resume` (opencode's registry entry says `supports.resume: false`, so the broker will reject with `RESUME_UNSUPPORTED` per the iter-17 fix; not exercised live).
- Broker-survives-companion-exit and two-Claude-sessions isolation (backend-agnostic, passed for codex).

## Auth note

Opencode needs an LLM provider configured. In the live proof, the credential was
supplied as a session-scoped environment variable:

```sh
OPENROUTER_API_KEY="<redacted>" consult delegate --agent opencode ...
```

That's a session-scoped env var; no creds are written to disk by the plugin. The registry entry's `notes` field flags this requirement.

## Sandbox proof note

On 2026-05-18, the profile was configured from the already-installed
`opencode` binary with no package install:

```sh
node scripts/consult-companion.mts setup --install opencode
```

An unsandboxed Consult probe then passed and returned
`ok-opencode-unsandboxed`. The matching
`CONSULT_AGENT_SANDBOX=bwrap` probe initially failed before ACP initialize with
`AGENT_INIT_FAILED`.

After configuring the runtime so provider auth was available without printing or
persisting any secret values, the bwrap initialize probe passed. Direct opencode
with an explicit OpenRouter model returned `ok-opencode-direct-20260518`,
unsandboxed Consult opencode returned `ok-opencode-unsandboxed-rerun`, and
`CONSULT_AGENT_SANDBOX=bwrap` Consult opencode returned
`ok-opencode-sandboxed`.

Release-readiness rerun on 2026-05-19 also passed:

- Direct `opencode run -m openrouter/anthropic/claude-sonnet-4.5 "respond with exactly: ok-opencode-direct-20260519"`
  returned `ok-opencode-direct-20260519`.
- Unsandboxed Consult opencode returned `ok-opencode-unsandboxed-20260519`.
- `CONSULT_AGENT_SANDBOX=bwrap` Consult opencode returned
  `ok-opencode-sandboxed-20260519`.

Host-adapter rerun on 2026-05-22 with `opencode` v1.15.7 and the local
opencode GitHub Copilot OAuth credential also passed:

- Direct `opencode run "respond with exactly: ok-opencode-run-20260521"`
  returned `ok-opencode-run-20260521`.
- `consult setup --install opencode` returned `verified opencode`.
- Codex Host autodetection to opencode Profile passed:
  `PATH="$PWD/bin:$PATH" CONSULT_HOST_SESSION_ID=codex-to-opencode-live-20260521 consult delegate --agent opencode --read-only --json -- "respond with exactly: ok-codex-to-opencode-20260521"`
  returned `ok-codex-to-opencode-20260521` with Job `job-hrWMfcG-avzR`.
- opencode Host autodetection to opencode Profile passed:
  `PATH="$PWD/bin:$PATH" consult delegate --agent opencode --read-only --json -- "respond with exactly: ok-opencode-host-to-opencode-20260521"`
  returned `ok-opencode-host-to-opencode-20260521` with Job
  `job-BBzHL3lsTRQu`.

The persisted Codex-to-opencode Job records `host: "codex"`,
`hostSessionId: "codex-to-opencode-live-20260521"`, and
`profile: "opencode"`, confirming that Codex invokes Consult as the Host while
Consult talks ACP to the opencode Profile.

## Open follow-ups

None specific to opencode. The defense-in-depth caveat on write-mode-outside-workspace applies the same way as it does to codex; see `docs/conformance/codex.md` for the full backstop rationale.
