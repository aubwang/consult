# Job-scoped Brokers with Host Session-scoped resume

Status: Accepted

Supersedes:

- [0001 Broker per (host, host-session, profile, workspace)](0001-broker-per-profile-per-workspace.md)
- [0002 Per-profile, per-workspace session resume](0002-per-profile-session-resume.md)
- [0006 Host Session cleanup with idle timeout fallback](0006-host-session-cleanup-with-idle-timeout-fallback.md)

Each active **Job** owns one live **Broker** process. The Broker is still a
separate Unix-socket daemon that owns the ACP-agent child, JSON-RPC transport,
permissions, filesystem handlers, and Job runtime, but its live locator is now
keyed by `jobId` under `brokers/<job-id>.json`. The Broker exits after its Job
finalizes and removes its live state, pid file, and socket on normal shutdown.

Durable Job history remains outside the Broker lifecycle. Finalized Jobs are
stored under `jobs/<job-id>.json`, with session/update logs under
`logs/<job-id>.log`, so status/result/resume history survives Broker exit.

We chose job-scoped Brokers over warm Brokers scoped to
`(Host, Host Session, Profile, Workspace)` because the warm model made Broker
lifetime and Job lifetime diverge. A completed Job could leave a healthy but
surprising background daemon behind, while a future Job could inherit process
state from an earlier Job. The shipped behavior is simpler to reason about:
one active Job, one Broker, one backend process, one cleanup point.

Host Session identity still matters, but no longer owns normal Broker lifetime.
`host` and `hostSessionId` remain on Job and Broker metadata so default
`--resume` can search only the current `(Host, Host Session, Profile,
Workspace)` and Host Adapter lifecycle hooks can perform best-effort cleanup
for still-running Brokers owned by that Host Session. Explicit
`--resume-job <job-id>` is the cross-Host-Session escape hatch and must match
the selected Profile.

The old idle-timeout fallback is retained only as a defensive guard for an idle
daemon. Normal completion does not wait for Host Session end or idle timeout:
the terminal Job path schedules Broker shutdown after the final Job record is
persisted and subscribers are notified.

Consult exposes Broker inspection and cleanup through `consult brokers`.
Inspection lists live locator files and classifies each as `running`, `stale`,
or `malformed`. `consult brokers --cleanup` removes stale/malformed locators,
and `consult brokers --cleanup <job-id>` tears down the named Broker.

## Consequences

- Parallel Jobs in the same Host Session/Profile/Workspace run in separate
  Broker/backend processes instead of serializing behind a shared warm Broker.
- `BROKER_BUSY` still exists, but now only protects duplicate/inconsistent work
  inside one Job-scoped Broker.
- Normal Broker cleanup is tied to Job finalization. Host lifecycle hooks are a
  best-effort fallback, not the primary lifecycle mechanism.
- Default `--resume` is intentionally narrower than durable Job history:
  current Host Session + selected Profile + Workspace. Users who need an older
  or cross-session Job use `--resume-job`.
- Operators have an explicit stale-state cleanup surface instead of relying on
  an unrelated future delegate to detect and clean stale Broker locators.
