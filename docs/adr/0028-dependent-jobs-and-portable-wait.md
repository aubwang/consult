# Dependent Jobs and Portable Waiting

Status: Accepted

## Context

Background Jobs currently let a Host fan work out, but predictable multi-stage
work still requires the Host model to collect one result and issue the next
command. Repeated model-driven status checks waste tokens, while Host-specific
completion injection would tie Consult to proprietary live-session APIs.

Consult needs a small portable join and a way to predeclare only those
transitions that require no intermediate Host judgment, without becoming a
general workflow scheduler.

## Decision

Consult supports repeatable `delegate --background --after <job-id>`
dependencies on existing Jobs in the same Workspace. A detached dependent
worker waits for every prerequisite. Only `completed` prerequisites start the
Profile; failed, cancelled, or skipped prerequisites finalize the dependent Job
as `skipped` without a model call.

Successful upstream final text is appended to the dependent prompt in declared
order inside an explicitly untrusted UTF-8-safe block capped at 256 KiB total.
Dependency edges are orchestration metadata, not Delegation Chain lineage: they
do not transfer authority, cancellation parentage, patches, or Profile Session
state.

`consult wait <job-id>...` is the portable completion join. It blocks once and
returns the selected versioned Job Results. SIGINT and SIGTERM best-effort
cancel still-active selected Jobs and their linked descendants by default;
`--keep-running` opts out.

Consult does not inject completion prompts into Host sessions. Host-specific
app-server, hook, or TUI APIs remain outside the portable CLI contract.

## Consequences

- Hosts can predeclare predictable research, review, and synthesis pipelines
  without spending model turns polling or supervising mechanical transitions.
- Hosts must inspect an upstream result before creating the next Job whenever
  the downstream prompt, authority, model, or existence depends on judgment.
- One lightweight detached worker remains alive while each dependent Job waits;
  no permanent scheduler or daemon is added.
- Dependency waiting and `consult wait` each use a bounded 30-minute wait.
- Interrupt cleanup is best effort. SIGKILL and detached Jobs with no active
  waiter provide no portable Host-stop signal.
