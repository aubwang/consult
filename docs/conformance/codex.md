# Codex ACP Conformance

> **Historical report.** This page records the May 2026 cooperative ACP
> permission and legacy optional-bubblewrap implementation. Its statements
> about missing preventive read-only enforcement, selected Host config mounts,
> and a Consult “plugin” do not describe ADR-0027's current default native Job
> Authority boundary. See [`README.md`](README.md#job-authority-confinement).

Date: 2026-05-15
Workspace under test: the local Consult checkout, plus temporary git workspaces
for write tests.
Backend: codex-acp v0.14.0 wrapping codex CLI v0.130.0 (`Logged in using ChatGPT`)
Plugin commit at first pass: `e4651c4`. Updated through `a272e97` (read-only backstop) and the iter-8 conformance sweep.

## Summary

First real end-to-end check against the codex backend. The plain "return a string" path works. Read-only enforcement is broken. Job-record persistence on the foreground path is incomplete. CLI arg parsing has a greediness bug that surfaces on any boolean flag preceding the prompt.

## What passed

- **`/consult:setup --install codex`** (github-release install type). Downloaded the v0.14.0 prebuilt tarball, verified the published sha256 digest, extracted to `<dataDir>/bin/codex/`, ran the ACP `initialize` smoke probe, and persisted the profile with `lastVerifiedAt`.
- **`/consult:setup --set-default codex`** updated `profiles.json` correctly.
- **Foreground delegate (read-only path that *should* be denied excluded)**: `delegate --agent codex "what is 2+2? respond with just the number"` returned `4`. The broker spawned, initialize succeeded, the prompt turn completed, and the job report displayed "completed".

## What failed

### `--read-only` does not deny edits (P0)

Command (run from a temp workspace):

```sh
delegate --read-only -- "create a file called test.txt with content hello"
```

Outcome: `test.txt` was actually written to disk. The job log records an `update` notification of `kind: edit` with `rawInput.auto_approved: true`. The codex-acp shim treats this class of edit as auto-approved on its side and never sends a `session/request_permission` to the consult plugin, so `permissions.mts` never gets a chance to deny it.

Implication: read-only mode is only honored for tool calls the backend chooses to route through ACP's permission RPC. For codex specifically, in-workspace edits bypass it.

Investigation directions:
- Check whether codex-acp's `initialize` request accepts a client-set "ask for every permission" override (some ACP agents expose this via `clientCapabilities` or `sessionConfiguration`).
- If no such knob exists, consider tracking `session/update` notifications with `kind: edit` while `mode: "read-only"` and aborting the broker session (or marking the job as policy-violation-failed) the moment one is observed. This is a detect-and-kill backstop, not prevention.
- Long-term: workspace-level filesystem sandbox (e.g. mount read-only) is the only ironclad enforcement; consider for v2.

Resolution:

Track A found ACP session modes (`session/set_mode`) in the protocol and codex-acp, but no codex-acp initialize/session config/env/CLI knob that guarantees every edit is routed through `session/request_permission` for consult to deny. The implemented fix uses the Track B broker backstop: while a consult job is in `read-only` mode, the broker inspects incoming `session/update` notifications before buffering or forwarding them. If an edit-shaped update, or an update with `rawInput.auto_approved: true`, arrives without a matching prior denied permission request, the broker stops forwarding updates for that job, sends `session/cancel`, finalizes the job as `failed` with a policy-violation error, writes the failed job record, and clears `BROKER_BUSY` so the user can submit another job.

This protects consult's job stream and state from silently treating an auto-approved backend edit as successful. It is still defense in depth, not prevention: codex-acp may have already written to disk before it reports the auto-approved edit update. A workspace-level read-only filesystem sandbox remains the only hard boundary.

Severity: blocks any v1 claim that `--read-only` is a meaningful safety boundary.

### Foreground job record is missing most fields (P0)

After `delegate --agent codex "what is 2+2?..."` completed, the on-disk job record at `<workspace>/jobs/job-auDxAwq0qgY0.json` was:

```json
{
  "jobId": "job-auDxAwq0qgY0",
  "status": "completed",
  "stopReason": "end_turn",
  "sessionId": "019e2a15-f275-7e21-a07e-33af7cec92d0",
  "startedAt": "2026-05-15T05:22:21.575Z",
  "completedAt": "2026-05-15T05:22:27.178Z"
}
```

Missing: `kind`, `profile`, `mode`, `prompt`, `claudeSessionId`, `submittedAt`, `finalText`.

A second delegate in a different workspace produced a fully-populated record (with `kind: delegate`, `mode: read-only`, `profile: codex`, `prompt`, `claudeSessionId`, `submittedAt`, `finalText`). So the difference is path-dependent, not registry-dependent.

Consequences:
- `/consult:status` shows blank `profile` / `submittedAt` columns for the affected jobs.
- `/consult:result job-auDxAwq0qgY0` returns empty stdout because there's no `finalText` to render.

Investigation directions: compare the submission code path for the first delegate vs subsequent ones. Suspect: foreground delegate's pre-submission job record write is conditional or racing with the finalize write, and `atomicWriteJson` is doing a full replace rather than a merge. May want a guaranteed-fields-present test that exercises a fresh-workspace foreground delegate end-to-end.

Severity: blocks `/consult:status` and `/consult:result` from being usable.

### CLI args parser greedy-consumes after boolean flags (P1)

`scripts/lib/args.mts#parseArgs` treats every `--name` token as a value flag when the next argv element doesn't start with `--`. So:

```sh
delegate --read-only "create test.txt"
# parsed as: flags["read-only"] = "create test.txt", positional = []
# error: delegate prompt is required
```

Workaround that works today: `delegate --read-only -- "create test.txt"`.

Investigation directions:
- Approach 1: hardcode a boolean-flag allowlist in the parser. Forces every new boolean flag to be added to the list — annoying but explicit.
- Approach 2: require `--name=value` syntax for value flags and treat bare `--name` as always-boolean. Cleaner contract but breaks current `--agent codex` / `--prompt "..."` usage.
- Approach 3: pass per-command flag definitions (boolean vs value) into the parser. Matches yargs/commander idioms; biggest refactor but most correct.

Severity: any user who runs `--read-only "..."` (the documented form) without the `--` separator gets an unhelpful error. The `--write`, `--background`, `--resume`, `--fresh`, `--wait` flags have the same bug.

## Iter-8 sweep (after the three P0/P1 fixes landed)

Run from a fresh temporary git repo with `CONSULT_CLAUDE_SESSION_ID=iter-8`.
Each test is a real OpenAI API call through codex-acp.

| Check | Outcome |
|---|---|
| `delegate --write` allows in-workspace edit | **PASS** — `hello.txt` written with the requested content. |
| `delegate --write` rejects edits outside the workspace | **FAIL (new P0)** — codex auto-approved `apply_patch /tmp/outside-attempt.txt`; the file was written. Same root cause as the read-only auto-approval bypass: codex-acp emits the edit with `rawInput.auto_approved: true` and never sends `session/request_permission`, so the path-confinement check in `permissions.mts` never runs. The read-only backstop in commit `a272e97` only triggers in read-only mode; write mode legitimately allows in-workspace edits and currently has no path check on auto-approved updates. |
| `delegate --background` + `status` + `result` round-trip | **PASS** — `delegate --background` returns a queued job id; `status` shows the job; `result <id>` returns the final text (`"queued"`). All metadata fields persisted (kind, profile, mode, prompt, claudeSessionId, submittedAt, completedAt, finalText). |
| `cancel` mid-prompt frees `BROKER_BUSY` within 2s | **PASS** — submitted a "count to 100" background job; `cancel <id>` returned `{"ok":true}` in **154 ms**; worker pid logged as terminated; job record marked `status: cancelled`, `stopReason: cancelled`. |
| `delegate --resume` round-trip | **PASS** — after a foreground delegate, `delegate --resume "what was the previous prompt?"` reattached to the prior session and returned a contextual answer. (The agent's response references the prior session's system context rather than the user prompt history, but session reattach itself works.) |
| Broker survives companion exit | **PASS** — after a foreground delegate exited, the broker file (`codex-iter-8.json` + `.pid.json`) remained on disk; a fresh `status` invocation from a separate companion process listed all jobs from this and previous test sessions, with full metadata. |
| Two-Claude-sessions-in-one-repo isolation | **PASS** — back-to-back foreground delegates with `CONSULT_CLAUDE_SESSION_ID=iter-8-sessionA` and `iter-8-sessionB` against the same workspace each spawned their own broker file (`codex-iter-8-sessionA.json`, `codex-iter-8-sessionB.json`). Both succeeded; neither tore the other down. |

## Companion disconnect drill

The real companion process disconnect path is covered by
`npm run drill:companion-disconnect`. The drill uses the fake ACP agent rather
than a live paid backend: it launches the real `consult-companion.mts delegate`
CLI, waits for a slow prompt update, sends `SIGKILL` to the companion process,
and asserts that the broker records the Job as `cancelled`, receives one
`session/cancel`, and removes live Broker state.

## Iter-12 zoom-out: codex-review live test

| Check | Outcome |
|---|---|
| `/consult:review --agent codex` end-to-end | **PASS** — created a tiny diff (add a `console.log` to a fresh git repo), ran `review --agent codex`, got a substantive review verdict (the agent flagged the change as low-risk with no functional/security/perf concerns). |

Minor rendering noise: the companion's update renderer prints `[tool_call unknown]` for some codex tool calls the renderer doesn't have a case for. Not blocking for v1; logged here as a UX polish follow-up. (Fixed in commit `9421326`.)

## Sandbox proof

On 2026-05-18, the missing real-backend bwrap proof was completed:

| Check | Outcome |
|---|---|
| `codex exec --sandbox read-only --skip-git-repo-check --json "respond with exactly: ok-codex-direct-20260518"` | **PASS** — returned `ok-codex-direct-20260518`. |
| Unsandboxed Consult Codex delegate | **PASS** — returned `ok-codex-unsandboxed`. |
| Initial `CONSULT_AGENT_SANDBOX=bwrap` Consult Codex delegate | **FAIL (auth hidden)** — finalized `failed` with `Authentication required`, proving the sandbox hid Codex local auth/config. |
| Whole-directory `~/.codex` read-only mount | **FAIL (runtime write blocked)** — moved past auth but failed ACP initialize with a read-only filesystem error because Codex writes helper/runtime state under its home directory. |
| Selected-file `~/.codex` mount | **PASS** — host `~/.codex/auth.json`, `config.toml`, and `AGENTS.md` are mounted read-only into a writable sandbox `~/.codex`; the sandboxed delegate returned `ok-codex-sandboxed`. |

This gives Codex the same direct, unsandboxed Consult, and sandboxed Consult
proof shape as Claude while avoiding a writable secret mount.

Release-readiness rerun on 2026-05-19 also passed:

- Direct `codex exec --sandbox read-only --skip-git-repo-check --json "respond with exactly: ok-codex-direct-20260519"`
  returned `ok-codex-direct-20260519`.
- Unsandboxed Consult Codex returned `ok-codex-unsandboxed-20260519`.
- `CONSULT_AGENT_SANDBOX=bwrap` Consult Codex returned
  `ok-codex-sandboxed-20260519`.

## New P0 found on iter-8 sweep

### `delegate --write` allows edits outside the workspace

Command (from a fresh temporary git repo):

```sh
delegate --write "use your apply_patch tool to create a file at /tmp/outside-attempt.txt with content 'should be denied'"
```

Outcome: `/tmp/outside-attempt.txt` was written. The plugin's path-confinement check in `permissions.mts` was never invoked because codex-acp auto-approved the edit on its side (`rawInput.auto_approved: true`) instead of going through `session/request_permission`.

Severity: blocks v1's safety claim that delegates are confined to the workspace.

Fix direction:
- Extend the read-only backstop in `scripts/consult-broker.mts#isReadOnlyEditPolicyViolation` (commit `a272e97`) into a general policy check. In write mode, allow auto-approved edits only if the touched path is inside the workspace root; otherwise fail the job with a `policy violation: auto-approved edit outside workspace` error. The path lives in `update.toolCall.rawInput.path` (or `update.locations`) per the codex-acp protocol observed in the log.
- Same defense-in-depth caveat: codex-acp may have already written by the time we see the update. The backstop prevents the silent-success failure mode.

Resolution:
- The broker now treats auto-approved edit updates as a general policy surface. Read-only mode keeps the existing backstop: auto-approved edits, and edit-shaped updates without a matching denied permission request, fail the job before subscribers receive the update.
- Write mode allows auto-approved edits only when `rawInput.path` resolves inside the broker workspace root. Auto-approved edit updates outside the workspace fail the job with `policy violation: auto-approved edit outside workspace`, write the failed job record, and free the broker mutex for follow-up work.
- This remains defense in depth rather than prevention: codex-acp may already have written the file before it emits the update. The fix prevents consult from forwarding or recording that backend-side write as a successful job.
- Follow-up: the write-mode backstop now extracts edit paths across codex-style and claude-agent-acp-style tool-call update shapes, so non-codex backends are covered without relying on `auto_approved`.

## Open follow-up tasks (ordered)

1. ~~**Fix the args parser** so `--read-only "prompt"` works without `--`. (P1, isolated change.)~~ Done in `826f156`.
2. ~~**Fix the foreground job record gap**~~ Done in `eee70de`.
3. ~~**Investigate codex-acp auto-approval configuration**.~~ Track A turned up no knob; Track B backstop landed in `a272e97`.
4. ~~**Extend the policy backstop to write mode** so auto-approved edits outside the workspace fail with `policy violation: auto-approved edit outside workspace`.~~ Done; see the resolution above.
5. ~~Companion-disconnect-mid-prompt process drill.~~ Done with
   `npm run drill:companion-disconnect`; real-backend SIGKILL remains
   intentionally unnecessary for v1 because it risks runaway paid work.
