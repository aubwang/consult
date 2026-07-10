# Conformance reports

Live conformance status for the implemented Consult Profiles.

Job Authority confinement is now implemented for the built-in Codex and Claude
Profile identities on native Linux/macOS, with exact live preflight deciding
whether the current Host context is usable. The pinned runtime remains
**rejected for the nested macOS Codex Host path** because it cannot establish
its own proxy or Seatbelt boundary inside Codex's inherited sandbox. See the
[macOS Codex Sandbox Runtime spike](sandbox-runtime-codex-macos.md). This does
not imply a global macOS result: the unrestricted terminal control passed. The
[Linux Codex Sandbox Runtime spike](sandbox-runtime-codex-linux.md) records a
compatibility KEEP for two explicitly tested Host contexts and a KILL when
Codex's outer network-disabled seccomp policy blocks nested networking and the
runtime proxy listener.

On 2026-07-10, the integrated Linux adapter completed real confined turns for
Codex (`gpt-5.5`, Job `job-oHDFssztfWc9`) and Claude (`fable`, Job
`job-u63Nh1CpUIXf`). Selective cross-process resume then passed for Codex
(`job-tRD2PB7GIomI` -> `job-u9IU_4CMzXhW`) and Claude
(`job-N7MhIfAbBYJP` -> `job-iP7BeSfUnu7g`): each source and resumed Job archived
one Profile transcript while retaining direct-network denial and authenticated
model proxying. Product-level macOS adapter conformance remains to be run from
the Mac; the older spike is necessary evidence but not a substitute for that
final run.

Run the product-level harness from an unrestricted macOS terminal:

```sh
CONSULT_PACKAGE_SMOKE_CONFINED=1 bun run pack:check
bun run conformance:job-authority -- --agent codex --expect ready
bun run conformance:job-authority -- --agent claude --expect ready
bun run conformance:job-authority -- --agent codex --expect ready \
  --turn --model <known-supported-codex-model>
bun run conformance:job-authority -- --agent claude --expect ready \
  --turn --model fable
```

Then run the fail-closed control from the already-sandboxed macOS Codex Host:

```sh
bun run conformance:job-authority -- --agent codex --expect unsupported
bun run conformance:job-authority -- --agent claude --expect unsupported
```

The harness emits one redacted JSON object. Doctor/preflight performs real ACP
initialization but no model prompt. `--turn` runs a one-line model transport
canary, verifies its selective Session archive, resumes it through a second
fresh confined Profile process, and verifies the updated archive. An
`--expect unsupported` run additionally attempts delegation, requires the
stable nesting diagnostic, and proves no Job was created.

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

## Job Authority confinement

The cooperative ACP/backstop results above are not hard boundaries by
themselves. Current `delegate` and `review` requests default to canonical
read-only confined Job Authority. Built-in Codex and Claude launches receive a
private Job home/temp directory, a copied credential file or one selected
credential environment variable, Workspace access according to mode, and no
direct network. Model traffic uses an authenticated pinned-address proxy;
`--allow-fetch` deliberately broadens it to public TCP/443. That supports normal
HTTPS clients, but the proxy does not terminate TLS or prove the tunneled
application protocol is HTTP.

Whole Host config is not staged: Codex `config.toml` and Claude `settings.json`
are absent. Exact Profile initialization happens before Job creation, and
`consult doctor` runs that same live check. `--sandbox inherit` is an explicit
ambient-authority escape hatch and is never an automatic retry. The opencode
and custom Profile paths currently require inheritance; native Windows and
confined nesting are unsupported.

The older `CONSULT_AGENT_SANDBOX=bwrap` results below remain historical
conformance evidence for the legacy backend, not the current default contract.
On 2026-05-19 those probes passed direct CLI, unsandboxed Consult delegation,
and the optional legacy bubblewrap path for Claude, Codex, and opencode.

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
