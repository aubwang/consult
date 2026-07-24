# Grok Build ships at Codex/Claude parity, not privilege

Status: Accepted

## Context

Grok Build (xAI) is a coding agent that speaks ACP over stdio, so it can be a
Consult Profile. Making it a first-class Profile alongside `codex`, `claude`,
and `opencode` raises three decisions that ADR-0027 does not settle by itself.

First, Grok ships only an interactive shell installer
(`curl … | bash`). The registry's `cargo`, `npm`, and `github-release` install
types all execute a command, and `parseInstallCommand` deliberately refuses
shell syntax so Consult never spawns a shell for an install. There is no npm
package and the upstream repository publishes no release assets.

Second, Grok's documented automation posture is `grok agent --always-approve
stdio`, which auto-approves tool calls inside the Profile. Grok also defaults to
connecting to a **shared leader process** so several clients can share one
backend.

Third, Grok stores a Session as a directory
(`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`) rather than the single
transcript file that Codex and Claude use, which the selective confined Session
archive from ADR-0027 assumed.

## Decision

Grok is added to the shipped Profile registry with the **same** boundary Codex
and Claude receive under ADR-0027, and with no capability that would place it
above them.

**Install.** A new `manual` registry install type describes a Profile whose
vendor ships only an interactive installer. `consult setup --install grok`
verifies an existing `grok` on `PATH` and runs the ACP smoke probe; when the
executable is absent it reports the vendor's documented command and the docs
URL rather than running either. Consult never executes `curl … | bash`, and the
no-shell-syntax guard on install commands stays intact.

**Launch.** Consult launches `grok agent --no-leader stdio`. Two omissions are
load-bearing:

- No `--always-approve` (and no `_meta.yoloMode`). Grok's default `ask` mode
  routes tool calls through ACP `session/request_permission`, which is the same
  cooperative seam Consult's read-only/write Job policy already decides for
  Codex and Claude. Auto-approving inside the Profile would leave Consult's
  policy with nothing to decide.
- `--no-leader` is explicit. A shared leader would run the turn in a process
  Consult did not spawn, outside the Job's private home, egress proxy, and
  process-group ownership (ADR-0026), which would defeat confinement rather
  than merely weaken it.

**Confinement.** `grok` joins `CONFINED_PROFILE_POLICIES`: private per-Job
home/temp, `GROK_HOME` redirected into that home, one selected credential
(`CONSULT_XAI_API_KEY` → `XAI_API_KEY`, otherwise a copied `auth.json`), no
direct networking, and an exact-host proxy allowlist of `api.x.ai`,
`cli-chat-proxy.grok.com`, and `auth.x.ai`. `accounts.x.ai` is excluded: it is
an origin the CLI's loopback callback accepts a browser request *from*, not a
host it calls. Host
`config.toml`, `mcp_credentials.json`, and ambient `GROK_*` variables are not
staged, matching the Codex `config.toml` and Claude `settings.json` exclusions.
Grok's own `--sandbox` profiles are not used; Consult's boundary is the
authoritative one, and `GROK_SANDBOX` does not cross into the Job.

**Session continuity.** The confined Session archive carries a bounded
allowlist of the Session directory's conversation state — `updates.jsonl`
(required), `summary.json`, `chat_history.jsonl`, `plan.json`, and
`signals.json` — under one total size cap. Rewind snapshots, feedback,
compaction checkpoints, and subagent trees are excluded: they are not needed to
reopen a Session through `session/load`, `rewind_points.jsonl` holds copies of
Workspace files, and a smaller archive is a smaller thing to verify. The
manifest now describes one to eight hash-verified files instead of exactly one;
Codex and Claude continue to archive exactly one transcript.

## Consequences

- Grok delegation, review, background Jobs, and confined resume work the same
  way they do for Codex and Claude, with the same default read-only confined
  authority and the same `--allow-fetch` exfiltration caveat.
- `consult setup --install grok` cannot bootstrap the Profile on a machine that
  lacks it. That is the intended trade: an unattended `curl … | bash` is a
  larger risk than an extra manual step.
- The `manual` install type is reusable for future Profiles with the same
  distribution shape, and keeps "Consult can verify this" separate from
  "Consult can install this".
- Grok's Session layout is a vendor-private contract. If the file set changes,
  archival fails closed with `SESSION_STATE_ARCHIVE_FAILED` rather than
  reporting a resumable Job that cannot be resumed, and the allowlist needs a
  matching update.
- Live conformance is earned per Profile/OS/Host-context combination as usual;
  the deterministic packed matrix covers the Grok registry identity, and the
  live vendor run is tracked in `docs/conformance/grok.md`.
- Grok is a Profile, not an auto-detected Host. It exposes `GROK_SESSION_ID`
  only to hook subprocesses, not to the shell tool that would run `consult`, so
  there is no reliable ambient session id to detect. A Grok Host names itself
  with `--host`/`CONSULT_HOST`, exactly as a Claude Host does under ADR-0022.
