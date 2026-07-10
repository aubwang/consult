# Sandbox Runtime spike: Codex on Linux

Date: 2026-07-10

Status: **combination-specific.** Keep the pinned runtime for deeper evaluation
under an unrestricted Codex Host and under the tested Codex filesystem sandbox
with full outer networking. Kill it under the tested Codex filesystem sandbox
with networking disabled. None of these compatibility results ships product
confinement or proves Profile/model transport.

This report is spike evidence only. It does not change the current
`off | bwrap` sandbox surface and does not establish or supersede an ADR.

## Candidate and environment

- Package: `@anthropic-ai/sandbox-runtime@0.0.64`
- Machine: Linux x64, Ubuntu 24.04, kernel 6.8.0-134-generic
- Host: Codex CLI 0.144.1
- Profile target: Consult's pinned `codex-acp` integration

The opt-in probe is `bun run spike:sandbox-runtime-codex`. A decisive run must
declare its informational label through `CONSULT_SPIKE_HOST_CONTEXT`; the
harness never treats an absent `CODEX_SANDBOX` marker as evidence that a Host is
unrestricted. It separately records Linux `NoNewPrivs`, seccomp, and AppArmor
state and exercises user namespaces, base bubblewrap, a nested network
namespace, Unix-domain listening, runtime initialization, a wrapped
`/usr/bin/true`, and proxy cleanup.

Dependency warnings fail the preflight because the runtime can otherwise omit
its Unix-socket seccomp filter while continuing in a weaker mode.

## Results

| Host confinement context | Kernel evidence | Userns / base bwrap | Nested network bwrap | Unix listener | Runtime init / wrapped command / cleanup | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Codex Host, unrestricted | `NoNewPrivs=0`, `Seccomp=0`, AppArmor unconfined | PASS / PASS | PASS | PASS | PASS / PASS / PASS | **KEEP for deeper conformance** |
| Codex filesystem sandbox, network disabled | `NoNewPrivs=1`, `Seccomp=2` (one filter), AppArmor unconfined | PASS / PASS | **FAIL**: `NETLINK_ROUTE ... EPERM` | **FAIL** | **FAIL**: `listen EPERM` / SKIP / PASS | **KILL for this context** |
| Codex filesystem sandbox, full network | `NoNewPrivs=1`, `Seccomp=0`, AppArmor unconfined | PASS / PASS | PASS | PASS | PASS / PASS / PASS | **KEEP for deeper conformance** |

The confined runs used `codex sandbox` directly with a temporary named
permission profile supplied through command-line configuration. They did not
invoke a model. The profile gave `/` read access and the project plus `/tmp`
write access, then varied only Codex's outer network policy. The environment
label is descriptive; the kernel fields and primitive outcomes are the actual
nesting evidence.

The network-disabled result is fail-closed but unusable: Codex's seccomp policy
blocks both the Unix listener needed by the runtime proxy and the netlink
operation needed to create the nested isolated network. Consult must report
that combination as unsupported and may only proceed if its trusted Host
explicitly selects ambient inheritance.

The full-network confined result is not contradictory. That outer policy
allows the native primitives needed for Consult to add a stricter inner
filesystem/network boundary.

## Remaining gates

A compatibility KEEP is deliberately narrower than an integration decision:

1. `/usr/bin/true` is not Codex ACP. Selected auth/config staging, a fresh
   writable runtime home, actual Profile startup, model transport, and teardown
   remain unproved.
2. The pinned proxy validates a requested hostname and then delegates resolution
   to the host connection path. It does not prove public-address classification,
   resolution pinning, or DNS-rebinding/TOCTOU resistance. Consult's fetch grant
   cannot ship on that proxy unchanged.
3. Reads are allow-by-default and the runtime adds compatibility write paths.
   A Consult policy adapter must deny broad reads, explicitly re-allow only the
   runtime, Workspace, and selected Profile state, and counter every default
   write outside the intended Execution Workspace.
4. The wrapped-true cleanup check proves proxy reset, not cancellation of a
   long-running Profile and its descendants. Process-group ownership and a
   full-tree termination regression remain required.
5. A real standalone-terminal Linux control and other built-in Profiles remain
   separate Host/Profile/OS combinations.

## Decision

Keep `@anthropic-ai/sandbox-runtime@0.0.64` as the Linux candidate only for the
two combinations whose compatibility gates passed. Kill it for the tested
network-disabled Codex Host context. Do not silently reinterpret a failed
confined request as inheritance, and do not begin product integration until the
policy, egress, Profile transport, credential-minimization, and cleanup gates
pass.
