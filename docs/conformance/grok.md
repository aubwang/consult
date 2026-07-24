# Grok Build ACP Conformance

Date: 2026-07-24
Profile: `grok` (xAI Grok Build CLI, `grok agent --no-leader stdio`)
Platform under test: native macOS arm64, Node 24.18.0

## Summary

The `grok` registry identity passes the deterministic packed confinement
matrix, which proves Consult's own boundary — filesystem, egress, credential
staging, Session archival and restore, isolated write, cancellation, and
cleanup — against a fake ACP Profile that reproduces Grok's staging shape.

Live vendor conformance (real xAI authentication, real model transport, real
`session/load` against a Consult-restored Session directory) is **not yet
run**. Treat the `grok` Profile as boundary-verified and vendor-unverified
until the live harness below is executed and its redacted evidence recorded
here.

## Boundary verified (deterministic packed matrix)

`CONSULT_PACKAGE_SMOKE_CONFINED=1 bun run pack:check` on 2026-07-24 emitted:

```text
packed confined npm/codex matrix passed
packed confined npm/claude matrix passed
packed confined npm/grok matrix passed
packed confined bun/codex Doctor passed
packed confined bun/claude Doctor passed
packed confined bun/grok Doctor passed
package smoke passed (aubwang-consult-0.8.0.tgz, 84 files)
```

The `grok` run of that matrix asserts, from inside the confined Job:

| Check | Outcome |
|---|---|
| Private `GROK_HOME` holds the staged `auth.json` with the expected content | PASS |
| Host `.grok/config.toml` is absent from the staged config directory | PASS |
| `XAI_API_KEY`, `CONSULT_XAI_API_KEY`, and unrelated Host secrets do not reach the Profile | PASS |
| Workspace read succeeds; a read-only write attempt does not land on disk | PASS |
| Host-only read canary is invisible; Host write canary is unmodified | PASS |
| Direct loopback and direct public TCP/443 egress are denied | PASS |
| The no-fetch proxy refuses arbitrary public and loopback destinations | PASS |
| `--allow-fetch` permits public TCP/443 through the proxy but still refuses loopback | PASS |
| Write-mode Job edits inside the Workspace only | PASS |
| Isolated write Job returns a patch without touching the invoking checkout | PASS |
| Session state is archived, hash-verified, and restored into a fresh private home for `--resume-job` | PASS |
| Cancellation terminates the Profile process tree, including a descendant that ignores `SIGTERM` | PASS |
| Confined `doctor` reports `confined.ok` for the `grok` registry identity without creating a Job | PASS |
| No sandbox job root survives the run | PASS |

## Launch posture

Consult launches `grok agent --no-leader stdio`. Two deliberate omissions:

- **No `--always-approve` / `--yolo`, and no `_meta.yoloMode` on
  `session/new`.** Grok's default `ask` mode routes tool calls through ACP
  `session/request_permission`, which is where Consult's read-only or write Job
  policy decides them. xAI documents always-approve as the normal automation
  posture; adopting it would hand the decision to the Profile and leave
  Consult's policy with nothing to enforce cooperatively.
- **`--no-leader` is explicit.** Grok can otherwise attach to a shared leader
  process so several clients share one backend. That process is not the one
  Consult spawned, so it sits outside the Job's private home, egress proxy, and
  process-group ownership.

Grok's own `--sandbox` profiles are not used and `GROK_SANDBOX` does not cross
into the Job; Consult's boundary is the authoritative one.

The confined proxy allowlist is `api.x.ai` (API-key model traffic),
`cli-chat-proxy.grok.com` (signed-in session model traffic), and `auth.x.ai`
(the OAuth2 issuer, for refreshing a staged credential). `accounts.x.ai` is
deliberately absent: it is an origin the CLI's loopback callback accepts a
browser request *from*, never a host the CLI calls, and interactive login
cannot happen in a confined Job.

## Session archive shape

Grok stores a Session as `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/`
rather than a single transcript file. Consult archives a fixed allowlist of the
conversation state — `updates.jsonl` (required), `summary.json`,
`chat_history.jsonl`, `plan.json`, `signals.json` — under one total size cap,
and restores exactly those relative paths into the next private Job home.

Excluded on purpose: `rewind_points.jsonl` (snapshots of Workspace files, and
the documented largest disk contributor), `feedback.jsonl`,
`compaction_checkpoints/`, `subagents/`, `auth.json`, and
`mcp_credentials.json`. A target path outside
`.grok/sessions/<group>/<session-id>/<allowlisted file>` fails archive
validation.

Grok advertises `loadSession` but not `sessionCapabilities.resume`, so the
registry entry declares `supports: { resume: false, load: true }` and Consult
reopens a Session with ACP `session/load`.

## Not yet run

The live vendor harness. From an unrestricted macOS terminal with either
`CONSULT_XAI_API_KEY` set or a stageable `~/.grok/auth.json` from `grok login`:

```sh
consult setup --install grok
consult doctor --agent grok
bun run conformance:job-authority -- --agent grok --expect ready \
  --direct --turn --background
```

That run is what would establish real xAI authentication through the confined
proxy allowlist, real model transport, and that Grok's own `session/load`
accepts a Consult-restored Session directory. The `--turn` scenario is the
important one: it asks the Profile to remember a private marker, then requires
a second fresh confined Profile process to recall it after archive and restore.

Also unexercised: the already-confined Codex Host control (`--expect
unsupported`), and Linux. Nothing about Grok changes the platform matrix —
native Windows, macOS x64, and confined nesting remain unsupported — but those
combinations have not been observed for this Profile.

`scripts/live-job-authority-conformance.mts` accepts `--agent grok`; its
direct control builds an auth-only home from `GROK_HOME` (or `~/.grok`) so
unrelated Host configuration cannot confound the auth/transport result.
