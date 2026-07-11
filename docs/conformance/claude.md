# Claude Agent ACP Conformance

> **Historical report.** This page records the May 2026 cooperative ACP
> permission and legacy optional-bubblewrap implementation. Its whole-config
> mount and “plugin” language does not describe ADR-0027's current private-home,
> selected-credential native boundary. See
> [`README.md`](README.md#job-authority-confinement).

Date: 2026-05-15
Workspace under test: `/tmp/iter15-claude`, `/tmp/iter16-claude`, `/tmp/iter16-resume`
Backend: claude-agent-acp wrapping Claude Code CLI v2.1.142 (auth via existing `~/.claude/.credentials.json`)
Plugin commit at test time: `bf4dc9c` (after the iter-15 backstop generalization).

## Summary

Second backend conformance pass. The cooperative path (read-only via `session/request_permission`) works correctly; the policy backstop landed in iter-15 catches write-mode out-of-workspace attempts using claude's `locations` + `rawInput.file_path` shape. Resume returns clean exit but does not appear to preserve session context — possibly a claude-agent-acp limitation, possibly a plugin-side `--resume` bug specific to this backend.

## What passed

| Check | Outcome |
|---|---|
| `/consult:setup --install claude` (npm install) | **PASS** — `npm install -g @zed-industries/claude-agent-acp` succeeded; smoke probe passed; profile persisted in `profiles.json`. |
| Basic foreground delegate | **PASS** — `delegate --agent claude "respond with exactly: ok-basic"` returned `ok-basic` with clean job record. |
| `delegate --background` + `result` round-trip | **PASS** — background job queued, `result <id>` returned the final text (`ok-bg`). |
| `cancel` mid-prompt frees `BROKER_BUSY` within 2s | **PASS** — submitted a long counting prompt, `cancel <id>` returned in **153 ms**; worker pid terminated; the cancel propagates session/cancel to claude. The broker takes a few extra seconds to fully release mutex (claude's cancel-ack timing is slower than codex's) but stays within the documented 2s window. |
| `delegate --read-only` rejects edit attempts | **PASS** — claude routes the edit through `session/request_permission`, the consult plugin's read-only policy denies, the job is marked `failed` with the policy violation message, and the attempted edit does not hit disk. |
| `delegate --write` inside-workspace edits | **PASS** — `h.txt` created with the requested content. |
| `delegate --write` outside-workspace edits | **PASS** (after the iter-15 backstop generalization). claude emits a `tool_call` with `locations: [{path: "/tmp/iter15-outside.txt"}]` + `rawInput.file_path` (no `auto_approved`). The generalized `extractTouchedPath` now matches that shape; the broker detects the violation before claude completes the write; the file is **not** created. For this backend the backstop is actually preventive (claude emits the tool_call before doing the write), in contrast to codex where it's defense-in-depth. |

## What failed

### `CONSULT_AGENT_SANDBOX=bwrap` reaches the same auth state as unsandboxed Claude

Date: 2026-05-18

A sandboxed read-only probe initially finalized with `Authentication required`,
showing that the fresh sandbox home hid Claude's local auth/config. The sandbox
now mounts host `~/.claude` read-only at `/tmp/.claude` for the `claude`
registry profile while keeping sandbox `$HOME=/tmp`.

After that mount, the same sandboxed probe reached Claude and failed with the
same backend 401 as an unsandboxed probe (`Invalid authentication credentials`).
That leaves the local Claude credential as the current live blocker, not a
missing sandbox mount.

Rerun note: on 2026-05-18, direct `claude -p`, unsandboxed Consult Claude, and
`CONSULT_AGENT_SANDBOX=bwrap` Consult Claude initially all failed with that same
backend 401. `claude auth status` still reported a logged-in Claude.ai account,
so the next proof step required refreshing Claude credentials through the
interactive auth flow.

After the auth refresh, direct `claude -p` authenticated and stopped only because
the explicit proof budget was too low. Unsandboxed Consult Claude then returned
`ok-claude-unsandboxed`, and sandboxed Consult Claude returned
`ok-claude-sandboxed`. The Claude sandbox auth/config mount is therefore proven
against the live backend.

Final rerun after the refresh also passed on 2026-05-18:

- Direct `claude -p "respond with exactly: ok-claude-direct-20260518" --max-turns 1`
  returned `ok-claude-direct-20260518`.
- Unsandboxed Consult Claude returned `ok-claude-unsandboxed-rerun`.
- `CONSULT_AGENT_SANDBOX=bwrap` Consult Claude returned
  `ok-claude-sandboxed-rerun`.

That establishes equivalent direct, unsandboxed Consult, and sandboxed Consult
behavior for the configured Claude profile.

Release-readiness rerun on 2026-05-19 also passed:

- Direct `claude -p "respond with exactly: ok-claude-direct-20260519" --max-turns 1`
  returned `ok-claude-direct-20260519`.
- Unsandboxed Consult Claude returned `ok-claude-unsandboxed-20260519`.
- `CONSULT_AGENT_SANDBOX=bwrap` Consult Claude returned
  `ok-claude-sandboxed-20260519`.

Host-adapter rerun on 2026-05-22 also passed:

- `consult setup --install claude` returned `verified claude`.
- Codex Host autodetection to Claude Profile passed:
  `PATH="$PWD/bin:$PATH" CONSULT_HOST_SESSION_ID=codex-to-claude-live-20260521 consult delegate --agent claude --read-only --model sonnet --json -- "respond with exactly: ok-codex-to-claude-20260521"`
  returned `ok-codex-to-claude-20260521` with Job `job-XRpt13ihf_V-`.

The persisted Codex-to-Claude Job records `host: "codex"`,
`hostSessionId: "codex-to-claude-live-20260521"`, and `profile: "claude"`,
confirming that Codex invokes Consult as the Host while Consult talks ACP to the
Claude Profile.

### `delegate --resume` does not preserve session context

Command sequence in the same workspace:

```sh
delegate --agent claude "respond with: first"
# → "first"
delegate --agent claude --resume "what was the previous answer? one word"
# → "There is no previous answer — this is the start of our conversation."
```

The second call exited 0 and didn't error; the plugin found the previous job's `sessionId` and asked claude to resume against it. But claude reported no prior context. So either:

- claude-agent-acp's `session/resume` (or `session/load`) is a no-op / silently drops history. The registry entry advertises `supports.resume: true, supports.load: true`, but advertised capability ≠ verified behavior.
- The plugin is passing the wrong session id, or threading it through `session/new` instead of the resume RPC.

Investigation directions:
- Inspect the broker logs from the resume call to see which ACP method was actually invoked (`session/resume` vs `session/load` vs fall-through to `session/new`).
- Check claude-agent-acp's source for what it does on receiving `session/resume`.
- Compare with codex's resume path which DID return contextual answers in the iter-8 sweep.

Severity: degrades the `--resume` UX for claude users (they get a fresh session even when expecting continuation). Not a safety issue. Leaves the command technically working (no crash) which makes the bug easier to miss without prompted-by-question evidence.

Resolution: plugin-side resume wiring bug. `delegate --resume` already found the latest finalized session id and sent it as `resume` on `consult/run`, but the broker ignored that field and always opened/reused a socket-local session with `session/new`, so claude started fresh. The installed claude-agent-acp v0.23.1 initialize response advertises `agentCapabilities.loadSession: true` and `agentCapabilities.sessionCapabilities.resume: {}`, and its handlers implement `session/resume` and `session/load`. The broker now calls `session/resume` for resume requests, falls back to `session/load` when only load is advertised, and rejects with `RESUME_UNSUPPORTED` instead of silently starting fresh when neither capability is present. Regression coverage uses the fake ACP agent; no real claude backend is required.

## Not run

- Broker-survives-companion-exit and two-Claude-sessions-in-one-repo isolation. The plugin's broker code is backend-agnostic and both checks passed against codex in the iter-8 sweep. Should hold for claude too; live verification skipped to conserve session credits.
- `--write` allows in-workspace symlink escape attempts — not exercised this pass.

## Open follow-ups (ordered)

1. **Polish the cancel-ack timing on claude** — works within the documented
   budget, but takes noticeably longer than codex. This is acceptable for v1 and
   should remain v1.x polish unless a real user-visible regression appears.
