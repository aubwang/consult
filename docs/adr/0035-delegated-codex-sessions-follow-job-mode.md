# ADR 0035: Delegated Codex sessions follow the Job mode

## Status

Accepted.

## Decision

Consult pins the delegated Codex session's own approval/sandbox preset to the
Job mode. Every Codex Profile launch — confined, legacy bubblewrap, and
ambient — sets `INITIAL_AGENT_MODE` in the codex-acp environment: `read-only`
for a read-only Job and `agent` (workspace-write) for a write Job. A host- or
profile-supplied `INITIAL_AGENT_MODE` never reaches the delegate; the value is
always computed from the Job mode. Other Profiles are unaffected.

## Rationale

codex-acp starts every session in Codex's `agent` preset unless
`INITIAL_AGENT_MODE` says otherwise. Consult never set it, so even read-only
Jobs ran Codex in workspace-write. That mismatch was previously only a
cooperative-enforcement gap (the broker backstop caught auto-approved edits
after the fact). Codex's newer bubblewrap per-command sandbox on Linux turned
it into a hard stall: under a workspace-write preset it protects workspace
metadata by mounting read-only covers over `.git`, `.agents`, and `.codex`
beneath each writable root, and a missing cover target must be created before
it can be mounted. Inside a read-only Job the Workspace is mounted read-only,
so the `mkdir <workspace>/.codex` mount-point creation fails with `EROFS` and
every shell-mediated command dies before it runs (`bwrap: Can't mkdir
<workspace>/.codex: Read-only file system`). macOS never surfaced this because
Seatbelt covers are policy text, not mount points.

Codex's `read-only` preset takes the failing setup off the table entirely: its
restricted policy builds the command filesystem from a fresh tmpfs root plus
read-only binds, has no writable roots, and therefore creates no metadata
cover targets. It is also the semantically correct inner boundary — a
read-only Job should not hand its delegate a wider inner sandbox than the Job
Authority it runs under. Commands still run without per-command approval
round-trips; only escalations request permission, which
`scripts/lib/permissions.mts` already denies in read-only mode.

Pinning rather than passing through is deliberate: `INITIAL_AGENT_MODE` is an
authority-shaped knob, and an ambient `agent-full-access` value leaking into a
delegated session would widen the delegate beyond the Job's granted authority.

## Consequences

Read-only Codex Jobs now get preventive read-only enforcement from Codex's own
sandbox in addition to the outer boundary and the broker backstop, and
Linux confined read-only delegation works with Codex CLI builds that use the
bubblewrap per-command sandbox. Commands inside read-only Jobs can no longer
write scratch files through Codex's inner sandbox even where the outer
boundary would have allowed it (Job home/temp); read-mediated delegation is
unaffected. Older codex-acp releases without `INITIAL_AGENT_MODE` support
ignore the variable and keep today's behavior.
