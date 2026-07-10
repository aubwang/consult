# Profile process-group ownership

Status: Accepted

On POSIX systems, Consult spawns each Profile ACP process as the leader of a new
process group. Normal disposal and initialization-failure cleanup close ACP
stdin briefly, then signal the process group with SIGTERM and escalate to
SIGKILL after a bounded wait. Consult checks group liveness independently from
the leader pid, so a descendant remains owned even if the direct Profile child
exits first.

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
- A future Sandbox Runtime adapter may add its own sessions and PID namespaces;
  live conformance must still prove its parent-death and namespace teardown
  behavior rather than assuming an outer group signal reaches every inner
  descendant.
- An uncatchable kill of the Consult owner can still bypass user-space cleanup.
  Runtime backends should additionally use native parent-death mechanisms when
  available.
