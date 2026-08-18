# Interim Job reports and the Job event stream

Status: Accepted

A Job is one prompt turn, and until now the only thing it could say was its
final result. Work that discovers it is blocked, needs a decision, or has found
something that invalidates the plan had to either finish the turn or say
nothing. `consult report` gives a running Job a bounded, typed way to say it
early, and `consult events` gives a Host a way to read it back.

`consult report --type <blocked|decision_needed|discovery|progress> [--data
<json>] [--job <job-id>] -- <message>` appends exactly one NDJSON line to the
Job's existing per-job log:

```jsonc
{"method":"consult/report","params":{"jobId":"job-...","at":"...","type":"blocked","message":"...","data":{}}}
```

The Job identity comes from `--job`, else from `CONSULT_PARENT_JOB`, which
Consult already injects into every Job environment holding that Job's own id.
The Workspace comes from `CONSULT_WORKSPACE`, else from Git-root detection, so
an isolated Job resolves the original Workspace rather than its detached
worktree.

`consult events <job-id> [--follow] [--json] [--since <seq>] [--type <type>]`
returns those reports plus lifecycle transitions synthesized from the Job
record: `queued` at `submittedAt`, `running` at `startedAt`, and one `terminal`
event carrying the final status and error message. Report events carry a
sequence number derived at read time from their order in the file, starting at
1; `--since` resumes after one already read. Lifecycle events carry no sequence
and are always replayed, so a reconnecting reader still learns the Job ended.

## Why the log, and why no stored sequence

The per-job log is already the durable, append-only, multi-writer-tolerant
record for a Job. Reusing it means a report survives Broker death, needs no new
state file, no index, and no lock.

Each report is a single `O_APPEND` write of one line. POSIX guarantees such a
write is atomic against other appenders when it is smaller than `PIPE_BUF`
(4096 bytes on Linux). A report line can exceed that once `--data` is used, so
atomicity is not claimed as a guarantee for every line; it is why the *common*
case interleaves cleanly, and why nothing shares a line. A reader that catches a
partially flushed trailing line drops it and re-reads, exactly as
`consult logs --follow` already does.

Sequence numbers are derived rather than stored because storing one would
require a read-modify-write across processes — precisely the coordination the
append-only design avoids. Deriving at read time keeps each append independent
and self-contained.

## The running window, and who enforces it

A Job accepts reports only while its status is `running`. Outside that window a
report has no correct place in the stream: a line written while the Job is still
`queued` would render after the `running` transition it actually preceded, and a
line written after finalization would render before a `terminal` event that had
already happened.

Both ends are enforced at the reader, because the writer cannot enforce either.
The log is multi-writer by design — that is the point of a host-agnostic CLI —
so between any check a reporter performs and its append, the Broker may finalize
the Job. **The invariant is therefore a read-time rule: a reader stops admitting
report lines at the Job's `consult/finalized` line.** A report that lost the race
is void. It is in the file, but it is not in the Job's event stream, it does not
consume the 256-report budget, and no reader has to guess.

The writer's checks are best effort layered on top of that invariant, and exist
for the caller's benefit rather than the stream's. `consult report` refuses a Job
that is not `running` before appending, which catches the ordinary case cheaply,
and re-reads the record afterwards so a reporter that lost the race is told its
report was discarded (exit 5) instead of being told it succeeded. Neither check
is load-bearing: remove both and readers still agree on the same stream.

`consult logs` deliberately does *not* apply the void rule. It is the raw
transcript — the surface for asking "what was actually written to this file" —
and hiding a line there would make it lie. `consult events` is the contract
surface, and it is the one that voids. Applying the rule to `logs` would also
require carrying the "finalization seen" state across the incremental slices
`logs --follow` renders, for no gain in a debugging view.

## Bounds

Enforced by the writer, before the append:

- message: 4096 UTF-8 bytes, truncated on a code point boundary with the
  `[consult: report message truncated]` marker charged against the bound;
- `--data`: 16384 bytes serialized, rejected rather than truncated, because a
  clipped JSON payload is not parseable by the reader that asked for it;
- 256 reports per Job.

These exist because report lines bypass the Broker's persisted-log accounting:
the Broker meters `consult/update` and `consult/finalized` against the 16 MiB
per-Job log limit, but an external writer does not go through the Broker and
cannot be metered by it. The caps bound the worst-case external addition to one
Job's log at roughly 5 MiB, on top of a limit the runtime still enforces for its
own writes. The 256 cap is checked per writer, so concurrent reporters can
overshoot it by the number of concurrent appends; that is an acceptable slop
against a bound that exists to keep a file finite, not to be exact.

## Scope

**Version 1 works for `--sandbox inherit` Jobs only.** Confined Jobs cannot
execute anything: the permission layer denies every execute kind and the
`consult` binary is not staged into the sandbox PATH. A confined Job therefore
cannot report, the same reason confined nested delegation is unsupported. This
is a limitation of the delivery path, not of the record. Options for confined
delivery, all deferred until the `--allow-exec` roadmap lands: a staged report
shim with a narrow execute allowance; carrying reports over the ACP channel as
session-update metadata; or a writable mailbox file inside the sandbox drained
by the Broker.

The mechanism lives in Consult Core and stops at the file. Consult does not wake
a Host, does not push, and does not know what a Host does with a `blocked`
event. A Host that wants a notification tails `consult events --follow --json`
and decides for itself; adapters belong at the edges, in the Host, and never in
Consult.

## Consequences

- The per-job log now has a third method. `consult logs` renders report lines as
  `[report <type>: <message>]`, flattened to one line so the bounded tail window
  still counts lines the way a reader expects. Consumers parsing the log must
  keep ignoring methods they do not recognize.
- `consult events --json` introduces a second, smaller versioned envelope,
  `{"schemaVersion":1,"jobId":...,"events":[...]}`, because an event stream is
  not a Job Result and does not fit the four Job sections. `--follow --json`
  emits NDJSON: one `{"schemaVersion":1,"jobId":...,"event":{}}` per line.
  Both evolve additively under ADR-0023's rules.
- Exit code 5 widens from "result requested before finalization" to the general
  lifecycle-ordering violation, which now also covers a report on a Job outside
  its running window — still queued, already finalized, or finalized while the
  report was being written. Existing `result` behavior is unchanged.
- Report content is a Profile's claim about its own progress, exactly like a Job
  Result. It is data, never instructions, and it is bounded before it is stored.
- This narrows the "no Host-specific prompt injection or wake-up APIs" non-goal:
  Consult now records interim events portably, but still ships no wake-up API
  and no Host-side delivery.
