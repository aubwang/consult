# Worker validation, batches, and Pi

Date: 2026-09-14. Platform: native Linux, cgroup v2 with a usable systemd user
manager. Design: [ADR-0043](../adr/0043-worker-validation-batches-and-pi.md).

## Verified boundaries

- Native execution tests read back the kernel memory, swap, task, and CPU
  limits before launch, exercise the per-file limit, and verify scope teardown
  removes descendants that detached from the original process group.
- A synthetic ACP Profile under both built-in Codex and Claude identities
  requests execution permission and runs `node --test` inside confinement.
  It writes inside the isolated workspace and cannot write the source workspace.
- Isolated dependency tests verify independent `node_modules` files, reject
  escaping links, and exclude copied dependencies from returned patches.
- An unconfirmed worker shutdown fails the Job and preserves its workspace
  without capturing a patch or removing files potentially still in use.
- Installed Pi 0.84.4 uses a local synthetic OpenAI-compatible model endpoint.
  Reads succeed in both modes; requested writes fail in read-only mode and
  succeed in write mode. A fresh Pi process resumes persisted history in both
  modes. No vendor model service or production credentials are used.
- Deterministic Pi tests additionally cover retry settlement, Unicode framing,
  cancellation, transport death, model/thinking controls, and Host identity.
- Batch tests cover validation before any submission, the eight-Job bound,
  partial receipts, isolated writers, and wait selection/watch/timeout behavior.
- The packed CLI is installed through npm and Bun. Both installs set up a Pi
  fixture Profile, submit two Jobs, and collect their results through `wait`.
  The packed confined npm Codex/Claude matrix and Bun Doctor checks also pass.

## Reproduction

```sh
bun run typecheck
CONSULT_TEST_EXECUTION=1 CONSULT_TEST_PI=1 bun run test
CONSULT_PACKAGE_SMOKE_CONFINED=1 bun run pack:check
```

The native Pi test requires an installed compatible `pi` executable. The native
execution tests require Linux kernel/systemd support; opting in treats a broken
prerequisite as failure. The package matrix retains its public-network probe.

## Limits of the evidence

Pi remains inherit-only: its disabled tools are cooperative policy, not an OS
sandbox. Pi has no execution grant. These checks do not establish vendor auth
or live remote-model behavior. Native execution is supported only for confined,
isolated write Jobs on Linux; macOS execution is rejected. Per-Job resource
limits do not impose aggregate concurrency or total-disk quotas.
