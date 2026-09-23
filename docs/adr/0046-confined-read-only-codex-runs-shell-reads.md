# ADR 0046: Confined read-only Codex runs shell reads without its inner sandbox

Status: Accepted

Amends: ADR-0035 (delegated Codex sessions follow the Job mode)

## Context

Codex has no file-read tool that goes through ACP; it reads the checkout with
shell commands (`cat`, `sed`, `rg`, `ls`). ADR-0035 pinned read-only Jobs to
codex-acp's `read-only` preset because it was Codex's true `readOnly`
sandbox, which needs no writable roots.

codex-acp 1.7.0 (agentclientprotocol/codex-acp#430) kept the `read-only` id
but changed it to a `workspaceWrite` sandbox with on-request approval
(tracked upstream as agentclientprotocol/codex-acp#450; still unchanged in
1.13.0). On Linux that sandbox must create `.git`/`.agents`/`.codex` cover
mount points under the Workspace, and the confined read-only launch mounts the
Workspace read-only. Every shell command therefore fails with
`bwrap: Can't mkdir <workspace>/.agents: Read-only file system`. When the model
asks to rerun the command outside Codex's sandbox, codex-acp offers only one
reject option, `cancel`, which ends the turn. Read-only Codex reviews ended as
a bare `cancelled` on their first file read.

## Decision

The confined Sandbox Runtime launch of a read-only Job without a fetch grant
sets `INITIAL_AGENT_MODE=agent-full-access`. Codex then runs commands with no
inner sandbox and no approval round-trips. Consult's outer boundary is the
read-only perimeter:

- the Workspace and every other readable path are mounted read-only, so a
  command can write only the Job's private home and temp directories;
- direct networking is blocked, and the egress proxy admits only the Profile's
  model hosts, so a command cannot reach any other host;
- the Job keeps its wall-clock and persisted-log limits.

Every other launch keeps ADR-0035's pins. A read-only Job with `--allow-fetch`
keeps the `read-only` preset, because its proxy admits public hosts that an
executed command could reach. Legacy bubblewrap and inherited launches share
the Host network and also keep it. Write Jobs keep `agent`.

`--allow-exec` keeps its meaning: tests, builds, and local commands in an
isolated write Job under the cgroup resource bounds. Shell reads in a
read-only Job are not an execute grant, and Consult's permission layer still
denies any execute request a Profile routes through it in read-only mode.

## Consequences

- Confined read-only Codex Jobs can explore the checkout with shell reads.
- Those commands do not get the `--allow-exec` cgroup bounds (memory, process,
  CPU, file size). A runaway command is bounded only by the Job wall clock and
  host resources, as it was under Codex's own sandbox.
- A command can read what the confined Profile can read, including the staged
  model credential. It can reveal that only to the model host or in the Job
  result the Host already receives.
- Auto-approved edits are still caught by the broker backstop, and the outer
  mount prevents them from reaching the Workspace.
- If upstream restores a true `readOnly` preset, this decision can revert to
  ADR-0035's pin without changing the public surface.
