# Profile process-group ownership

Status: Accepted

On POSIX systems, Consult spawns each Profile ACP process as the leader of a new
process group. Normal disposal and initialization-failure cleanup close ACP
stdin briefly, then signal the process group with SIGTERM and escalate to
SIGKILL after a bounded wait. Consult checks group liveness independently from
the leader pid, so a descendant remains owned even if the direct Profile child
exits first.

Group liveness is not instantaneous after SIGKILL, because a Profile group is
several processes rather than one: an ACP shim plus the vendored agent binary
and its children. Consult therefore waits a configurable grace for the whole
group to disappear before reporting that it remained alive, defaulting to five
seconds and overridable through `CONSULT_FORCE_KILL_GRACE_MS`. The grace is a
ceiling, not a delay — the poll returns as soon as the group is gone.

Windows retains direct-child termination. Native Windows is outside the new
confinement surface, and this change does not attempt to add Windows Job Object
ownership.

## Consequences

- Foreground, inline-worker, and Broker launches share the same Profile-tree
  disposal behavior through `startAgent`.
- Agent initialization timeout and failure no longer leave child processes
  outside the normal cleanup path.
- Tests cover a Profile that leaves a descendant alive after its own exit and a
  group leader that exits before its grandchild.
- The post-SIGKILL grace is an operator-tunable ceiling rather than a fixed
  constant. A grace set at the observed reap latency of a real Profile group
  makes teardown succeed or fail by coin flip, so the default is deliberately
  generous; hosts that reap agent process groups more slowly still raise it
  without a code change.
- A future Sandbox Runtime adapter may add its own sessions and PID namespaces;
  live conformance must still prove its parent-death and namespace teardown
  behavior rather than assuming an outer group signal reaches every inner
  descendant.
- An uncatchable kill of the Consult owner can still bypass user-space cleanup.
  Runtime backends should additionally use native parent-death mechanisms when
  available.
