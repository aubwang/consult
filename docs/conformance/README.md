# Conformance reports

Live conformance status for the implemented Consult Profiles.

Experimental confinement work is recorded separately from shipped Profile
conformance. The pinned Sandbox Runtime candidate is currently **rejected for
the macOS Codex Host path** because it cannot establish its own proxy or nested
Seatbelt boundary inside Codex's inherited sandbox. See the
[macOS Codex Sandbox Runtime spike](sandbox-runtime-codex-macos.md). This does
not imply a Linux result or change shipped sandbox behavior.

| Profile | Setup | Basic delegate | Read-only deny | Write in-ws | Write out-of-ws | Background+result | Cancel | Resume | Notes |
|---|---|---|---|---|---|---|---|---|---|
| [codex](codex.md) | PASS | PASS | PASS (backstop) | PASS | PASS (backstop, defense-in-depth) | PASS | PASS (154ms) | PASS | 2026-05-19 direct/Consult/bwrap proof PASS with selected `~/.codex` auth/config file mounts. |
| [claude](claude.md) | PASS | PASS | PASS (cooperative) | PASS | PASS (backstop, **preventive**) | PASS | PASS (cooperative) | PASS (after iter-17 fix) | 2026-05-19 direct/Consult/bwrap proof PASS. Cancel works but is slower than codex. |
| [opencode](opencode.md) | PASS | PASS | PASS (cooperative) | PASS | PASS (backstop, defense-in-depth) | PASS | — | — | 2026-05-19 direct/Consult/bwrap proof PASS with provider auth configured. |

Legend:
- **PASS**: live-verified end-to-end against the real backend.
- **AUTH-DEFERRED**: backend reachable but live delegate is intentionally out of
  scope until a per-backend auth prerequisite is satisfied.
- **—**: not exercised this pass; falls back to unit-test coverage where applicable.
- **cooperative**: enforced via ACP `session/request_permission` going through `scripts/lib/permissions.mts`.
- **backstop**: enforced via the broker's `isAutoApprovedPolicyViolation` check on `session/update` notifications. For backends that emit the tool_call BEFORE writing (claude), the backstop is preventive. For backends that emit AFTER writing (codex, opencode), it's defense-in-depth — the file may already be on disk before we see the update.

## Tests done in the policy backstop's path-extraction

The backstop's path-extraction (`extractTouchedPath` in `scripts/consult-broker.mts`) tries these in priority order to find the touched path on a `kind: edit` `session/update`:

1. `update.locations[0].path` — ACP-standard, used by claude-agent-acp.
2. `update.toolCall.rawInput.path` — codex shape.
3. `update.toolCall.rawInput.file_path` — claude alternate.
4. `update.rawInput.path` — top-level codex variant.
5. `update.rawInput.file_path` — top-level claude variant.

Both codex and claude shapes are unit-tested in `scripts/consult-broker.test.mts`. Opencode appears to share the codex-style shape from live testing (`auto_approved: false` but rawInput.path on the tool call); not separately unit-fixtured.

## Workspace-level filesystem sandbox

None of the backstops above are a hard boundary by themselves.
`CONSULT_AGENT_SANDBOX=bwrap` adds an opt-in bubblewrap layer around the ACP
agent process: read-only jobs mount the workspace read-only, and write jobs mount
only the workspace writable. It is off by default because real backends may need
explicit auth/config mounts before they can run inside the namespace. The
`claude` registry profile now mounts host `~/.claude` read-only at `/tmp/.claude`
inside the sandbox.

The `codex` registry profile mounts selected host `~/.codex` auth/config files
read-only into a writable sandbox `~/.codex`. Mounting the whole directory
read-only authenticated Codex but broke runtime/helper writes, so the narrower
file mount is the supported shape.

The `opencode` registry profile may require provider credentials from the host
environment. In the live proof, no secret value was printed or persisted by
Consult.

On 2026-05-19, release-readiness probes reran and passed direct CLI,
unsandboxed Consult delegation, and `CONSULT_AGENT_SANDBOX=bwrap` Consult
delegation for `claude`, `codex`, and `opencode`.

On 2026-05-22, Host autodetection was live-verified for the primary supporter
goal: `consult delegate --agent opencode` returned
`ok-codex-to-opencode-20260521`, and `consult delegate --agent claude`
returned `ok-codex-to-claude-20260521`. The reciprocal opencode Host path also
passed with `consult delegate --agent opencode` returning
`ok-opencode-host-to-opencode-20260521`.

## Resolved Risk: Parallel Broker-Test Flakiness

`scripts/consult-broker.test.mts` is the only test file that opens real Unix-domain sockets (via the fake-agent fixture). Running the full suite via `node --test "scripts/**/*.test.mts"` (default parallel mode) occasionally hangs or fails one of the broker tests, most commonly the early `prompt-pre-resolve-update` scenario. Running serially (`node --test --test-concurrency=1`) is consistently green at 226/226, so the bug is in the parallel-mode UDS choreography in the fixture or the broker's listen-fallback path, not in production code.

Historical CI implication was to run with `--test-concurrency=1` until this was rooted out.

### Resolution

The broker-test harness now uses a per-harness broker session id and tears the broker down before removing its temp socket directory. This keeps the fake-agent UDS endpoint and broker state unique for each test harness and prevents a live broker listener from surviving after its socket path has been removed. Verified on 2026-05-15 with `node --test "scripts/**/*.test.mts"` passing 5/5 in default parallel mode; an extra `--test-concurrency=16` stress run also passed after timing out before the fix.

## Broker disconnect recovery

Background Broker Jobs fail cleanly if the broker disconnects after accepting a
job but before sending `consult/finalized`. The worker persists the Job as
`failed` with `BROKER_DISCONNECTED` instead of waiting forever. Foreground Jobs
use the shared runtime inline. Focused coverage lives in
`scripts/lib/companion/delegate-core.test.mts`; stale broker teardown/respawn
remains covered in `scripts/lib/broker-lifecycle.test.mts`.

## Companion disconnect drill

`npm run drill:companion-disconnect` exercises the process-level companion
disconnect path without using a real backend. The drill creates a temporary
Workspace and Consult data root, installs the fake ACP agent Profile, launches
the real `scripts/consult-companion.mts delegate` CLI, waits for a slow prompt
update, sends `SIGKILL` to the companion process, and asserts that the
job-scoped Broker cancels the prompt, records the Job as `cancelled`, receives
one `session/cancel`, and removes live Broker state.

The 2026-05-24 run passed. The temp workspace/data root was removed after
success.
