# Mid-Job steering

Status: Accepted

ADR-0039 gave a running Job a way to say something before its turn ended. It
gave the Host no way to answer. A Job that reports `decision_needed`, or that is
visibly working from a constraint the prompt got wrong, could only be left alone
or cancelled — and cancelling throws away a turn that was mostly right.

`consult steer <job-id> [--message <text>] -- <guidance>` sends guidance into a
Job that is already running. Consult stops the in-flight prompt turn and
immediately re-prompts the **same live ACP Session** with the guidance framed
as a supervisor block:

```
--- BEGIN CONSULT SUPERVISOR GUIDANCE ---
<guidance>
--- END CONSULT SUPERVISOR GUIDANCE ---
The previous turn was stopped only to deliver this guidance. Continue the
original task from where it stopped, incorporating the guidance above.
```

The Job keeps its id, its Session and conversation, its log, its record, its
wall-clock deadline, and its persisted-log budget. Nothing resets. The
continued turn finalizes through the ordinary path, so a steered Job ends
`completed` exactly like an unsteered one.

## Mechanism

1. The CLI reads the Job record, refuses locally what cannot be steered, and
   dials the Job's Broker socket the way `consult cancel` does.
2. The Broker validates the request and hands it to the Job runtime, which
   records the guidance, marks a **pending steer** on the Job, and calls
   `session/cancel` on the live prompt turn.
3. When that turn settles, the runner consumes the pending steer instead of
   finalizing, and starts a new prompt turn on the same Session with the framed
   guidance. Normal finalization then applies to the continued turn.

The pending steer is the whole of the plumbing. It is a single nullable field
on the runtime's Job, deliberately **not** `cancelRequested`: the steer's
`session/cancel` must not look like a user cancel anywhere downstream. Because
`cancelRequested` stays false, the cancellation-wins merge in
`writeJobRecord` — which preserves a `cancelled` record against a later
writer — can never be triggered by a steer, and a steered Job cannot end up
`cancelled` by accident.

Cancellation still wins when it is real. A `consult cancel` that arrives while
a steer is pending sets `cancelRequested`, and consuming the pending steer then
returns nothing: the guidance is dropped rather than reopening a turn the
caller stopped.

Guidance accepted while a turn was running is honored whatever stopped that
turn, including an agent that finished on its own before the `session/cancel`
landed. The alternative — silently discarding guidance the Broker already
acknowledged and already wrote to the log — would make the accepted/delivered
distinction invisible to the caller.

An unacknowledged steer-cancel is not special-cased. It reuses the existing
cancel-ack timer: the Job fails with `agent did not acknowledge cancel` and the
Broker taints, exactly as an unacknowledged cancel does. A later `consult steer`
against a tainted Broker returns `BROKER_TAINTED` (exit 3). There is no retry
and no recovery path; a steer is one bounded request.

## Why not cancel plus `delegate --resume-job`

Cancel-then-resume looks like it reuses machinery that already exists, and it
was the shape sketched before this was implemented. It is worse on every axis
that matters here.

The Broker still holds the Session. Steering is not a resume: nothing is being
reopened, no session state has to be archived and restored, and no second Job
is created. Going out through cancel and back in through resume would trade a
live handle for a reconstruction — and that reconstruction has holes that
steering would inherit for free: `profileRejectsResume` excludes copilot
entirely, `--isolated` Jobs cannot resume, confined resume depends on the
session-state archive, and resume candidates exclude cancelled Jobs, which is
exactly what a cancelled-to-steer Job would be.

It also breaks the identity the Host is holding. A resumed Job is a new Job id
with a new record and a new log, so `consult wait`, `consult events --follow`,
and any Host-side bookkeeping keyed on the original id all have to be
re-pointed, and the Job's history is split across two logs. The Job the Host
steered would end `cancelled` — a terminal status that means something else.

## Support matrix (v1)

| Job | Steerable |
| --- | --- |
| background, non-isolated, `running` | yes |
| background, non-isolated, `queued` or final | no — exit 5 |
| foreground `delegate` | no — exit 1 |
| `--isolated` background | no — exit 1 |

Foreground and `--isolated` Jobs both run their prompt turn inside the
companion process through the inline runner (ADR-0021), which owns no socket
another process can reach; their records carry `runner: "inline"`, and the CLI
refuses them without dialing anything. The refusal names the alternative:
cancel and re-delegate with the guidance in the prompt.

Exit codes come from the existing contract table rather than a new one:

- **5** for a Job outside its running window, the lifecycle-ordering family
  ADR-0039 widened for the same reason: guidance sent before the turn starts or
  after it ends has no turn to join.
- **3** for a steer sent while one is still being delivered, the retryable
  contention family that already holds `BROKER_BUSY` — retrying after the first
  steer lands is exactly right.
- **2** for usage errors, an unknown Job, and oversized guidance.
- **1** for "this Job or Profile cannot be steered". Not 3, because a Host that
  retries will never succeed; not 2, because the invocation was well-formed.
  `exitCodeForBrokerError` already maps `RESUME_UNSUPPORTED` — the one existing
  per-Profile capability refusal — to 1, and this is its analogue.

## Bounds and the record

Guidance is bounded at 16 KiB UTF-8 and **rejected** rather than truncated,
mirroring `consult report --data`: a clipped instruction changes what the Job
is being told to do, which is worse than refusing to deliver it.

Unlike a report line, a steer line goes through the Broker, so it is metered
against the same 16 MiB persisted-log limit as `consult/update` — including the
terminal-diagnostic reserve — and a steer that would overrun the budget is
refused instead of pushing the Job past its own limit. The limit is not reset by
the steer, and neither is the wall clock: a Job cannot buy more of either by
being steered.

Only one steer is in flight at a time. That is not a rate limit; it is the
mechanism being honest. A second steer accepted before the first had produced
its turn would either be lost or silently merged.

## Reading it back

The Broker writes one line to the Job's existing log:

```jsonc
{"method":"consult/steer","params":{"jobId":"job-...","at":"...","guidance":"..."}}
```

The line is delivered to the Job's subscribers and persisted by the worker that
already owns that log, on the same notification chain as `consult/update`. That
is a deliberate departure from having the Broker append the file itself: the
Broker does not otherwise write the per-job log, and appending from a second
process would put the steer in a racy position relative to the updates it
interrupted. Routing it through the existing writer makes file order exactly
delivery order, and keeps one writer per Job log.

`consult events` synthesizes a `{"kind":"steer","type":"steer"}` event from
those lines. Reports and steers **share one sequence space**, derived in file
order, because they are one ordered stream of a Job's interim events: a reader
resuming with `--since` after a report must not be able to skip a steer behind
it. The `events --json` envelope stays `schemaVersion: 1`; a new event kind is
an additive change under ADR-0023.

A steer event's `message` is a bounded ~200-character preview, not the whole
16 KiB. The event stream is for deciding what to do next; the full guidance is
one line up in `consult logs`, which renders it as `[steer: <preview>]`.

Steer lines obey the same read-time void rule as reports: `consult events` stops
admitting them at the Job's `consult/finalized` line, while `consult logs`
remains the raw transcript and still shows a line that raced past finalization.

## The capability seam

`profileSupportsSteer(registryId)` sits next to `profileRejectsResume` and
returns true for every registry Profile in v1. It exists as a seam, not as a
guess: steering is `session/cancel` plus a new prompt on a live Session, so
none of `profileRejectsResume`'s persisted-approval concerns apply and no
Session state is reopened.

What would flip it to false is an ACP adapter that cannot survive
`session/cancel` and be prompted again — one that closes or wedges the Session
on cancel, resolves the cancelled prompt without ever reporting a stop, or
refuses a second `session/prompt` on a Session it has already cancelled. It is
checked in the Broker, where the Profile's registry identity is authoritative,
exactly like the resume check.

Per-agent native mid-turn injection — an agent that can take guidance without
stopping the turn at all — lands behind this same seam later. The CLI contract
does not change when it does.

## Consequences

- The per-job log now has a fourth method. Consumers parsing the log must keep
  ignoring methods they do not recognize.
- One Job can now run more than one prompt turn. The Broker stays busy across
  the whole sequence, so nothing else interleaves, and `consult/run` is still
  one Job per Broker.
- Guidance is instructions, not data. Unlike a Job Result or an upstream
  dependency's output, it comes from the Host that owns the Job, so it is framed
  as a supervisor block rather than fenced off as untrusted content. The Host is
  responsible for what it sends.
- This narrows the "no Host-specific prompt injection or wake-up APIs" non-goal
  a second time. Consult now carries guidance into a running Job portably, but
  still ships no Host-side delivery, no wake-up API, and no push channel.
