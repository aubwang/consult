# Sandbox Runtime spike: Codex on macOS

Date: 2026-07-10

Status: **KILL for nested confinement under `Host=Codex` on macOS.** Product
preflight must reject that exact Host context without implicit fallback. The
same package remains a candidate for unrestricted terminal and separately
tested Host/platform combinations.

This harness/report remains spike evidence. ADR-0027 later adopted portable Job
Authority and uses this report as the reason nested confinement under the
macOS Codex Host must fail preflight rather than fall back implicitly. The
unrestricted product-level adapter and real Profile controls later passed on
Apple Silicon and are recorded in [`README.md`](README.md).

## Candidate and environment

- Package: `@anthropic-ai/sandbox-runtime@0.0.64`
- lockfile integrity:
  `sha512-7w/+8g9p9RjUr7G9k1v/B5Edbw2GzjQ4Kigqdq0/LSudqOYi90+8+olOmwc1uInBbe2YLN+NDNrIf/jA4tNbCA==`
- Machine: Apple arm64, macOS 26.5.1, Darwin 25.5.0
- Host context: Codex with inherited Seatbelt confinement. The harness labels
  this context from the informational `CODEX_SANDBOX` marker; that marker is
  not a security identity or proof of kernel policy.
- Profile target: Consult's pinned `codex-acp` integration

The opt-in probe is `bun run spike:sandbox-runtime-codex`. It initializes the
runtime with network allowlists empty, local binding disabled, weaker network
and nested modes disabled, Apple Events disabled, and no writable paths. It
then tests native Seatbelt launch, runtime proxy initialization, wrapped child
launch, and proxy cleanup. The script is excluded from the published package.

## Results

### Inside the Codex Host sandbox

| Gate | Result | Evidence |
| --- | --- | --- |
| Runtime platform/dependencies | PASS | macOS supported; no dependency errors or warnings |
| Native nested Seatbelt | **FAIL** | exit 71: `sandbox-exec: sandbox_apply: Operation not permitted` |
| Runtime initialization | **FAIL** | `listen EPERM` while binding the runtime's temporary `srt-mux-*.sock` |
| Runtime-wrapped Profile launch | SKIP | initialization failed before any Profile/model work |
| Cleanup after failed startup | PASS | no proxy listener was established |

Both failures are fail-closed, which is necessary, but they make the runtime
unusable in the recorded Host run. The context marker only labels that run;
the exit-71 `sandbox-exec` result is the actual nesting evidence.

### Standalone macOS control

The identical probe was run from an unrestricted terminal context on the same
machine. Platform/dependency preflight, native Seatbelt launch, runtime proxy
initialization, wrapped `/usr/bin/true`, and proxy cleanup all passed. This
control isolates the incompatibility to nesting under the Codex Host rather
than a broken package or unsupported Mac.

## Secondary blockers found by static audit (historical)

These were blockers at spike time. ADR-0027 and the later adapter addressed
process-tree ownership, the Consult-owned pinned-address proxy, broad read
denial/default-write removal, and Job-private credential staging. They remain
useful regression requirements, not descriptions of the current implementation:

1. Consult currently disposes only the direct ACP child. Sandbox Runtime adds
   an outer shell, `sandbox-exec`, and an inner shell before the Profile. Static
   audit therefore identifies a process-tree cleanup risk. Any future adapter
   needs process-group ownership and a recorded regression test proving full
   Profile-tree termination before Broker/Job finalization.
2. The pinned proxy checks the requested hostname allowlist, then lets the host
   resolver and `net.connect` choose the destination. The audited HTTP and
   SOCKS paths do not classify and reject loopback, private, link-local, or
   metadata addresses and pin an approved resolved address. This does not meet
   Consult's provisional DNS-rebinding/TOCTOU requirement without an upstream
   fix or a narrowly maintained patch.
3. macOS reads are allow-by-default, so a Consult adapter would need broad
   `denyRead` plus explicit Workspace/runtime/auth re-allows. Sandbox Runtime
   also unions default writable paths into an otherwise empty write allowlist;
   strict read-only policy must explicitly deny those defaults.
4. Codex auth/config must be staged into a fresh, writable runtime home using
   only selected files. Mounting or allowing the full host `~/.codex` tree
   would violate the credential-minimization target and expose unrelated Host
   state.

## Decision

Kill `@anthropic-ai/sandbox-runtime@0.0.64` as the macOS confinement backend
when Consult is invoked from the Codex Host. Preflight for any future
experimental integration must report this combination as unsupported and must
never retry with inherited ambient authority implicitly.

At spike time, broader runtime evaluation remained open because native Linux
and an unrestricted macOS terminal were distinct combinations. ADR-0027 later
accepted the portable adapter only with combination-specific preflight and
fail-closed nesting; this historical KILL still governs nested macOS Codex.
