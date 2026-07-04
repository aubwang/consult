# Foreground delegate runs the ACP agent in-process

Status: Accepted

Foreground `consult delegate` (non-`--background`) no longer spawns a
job-scoped **Broker** daemon. The companion process itself spawns the ACP
agent, runs the single prompt turn, streams output, writes the same Job
records and NDJSON logs, and exits. `--background` Jobs and `consult review`
keep the Broker path: background work genuinely needs out-of-process lifetime,
and review depends on Broker RPC hooks for available-commands detection.

ADR-0001 justified the daemon-plus-IPC shape with amortized agent cold start
across many companion invocations and protocol-level `session/resume` needing
an agent that outlives the companion that started it. ADR-0016's job-scoped
Brokers made both justifications vestigial for foreground Jobs: a Broker now
lives exactly as long as its one Job, resume always starts a fresh Broker, and
a foreground delegate's client sits in the same lifetime as the Job. What
remained was pure overhead — a Unix socket, endpoint locator, pidfile,
reattach envelope, payload-hash idempotency, and a replay buffer serving a
client that never disconnects.

The inline runner is not a fork of the Broker. It reuses the Broker's job
runtime (record finalization, auto-approved-edit policy violation detection,
cancel-ack semantics) and the shared agent wiring (permission policy,
workspace-confined fs handlers, `CONSULT_PARENT_JOB` / `CONSULT_WORKSPACE`
lineage env, `CONSULT_AGENT_SANDBOX`), and it presents the same
`consult/run` → `consult/update` → `consult/finalized` contract to the
companion's prompt-turn runner. Behavior — records, logs, permission policy,
session controls, resume, exit codes — is identical to the Broker path.

Foreground Job records carry `runner: "inline"` and `runnerPid` (the companion
pid). Cancellation is by pid instead of by Broker endpoint:

- SIGINT/SIGTERM in the companion sends `session/cancel`, waits a bounded
  ~2 s for the turn to settle, disposes the agent (SIGTERM→SIGKILL
  escalation), marks the record `cancelled`, and re-raises the signal.
- `consult cancel <job-id>` sends SIGTERM to a live `runnerPid` so that
  handler does the graceful work; a dead `runnerPid` marks the record
  `cancelled` directly, mirroring the unreachable-Broker path.

## Consequences

- Foreground delegates create no socket, endpoint locator, or pidfile; one
  fewer process and no daemon spawn wait per foreground Job. `consult
  brokers` only ever shows background/review Brokers.
- `consult cancel` has two transports: Broker RPC for records without
  `runner: "inline"`, pid signalling for inline records.
- The Claude Code `SessionEnd` hook still only tears down Brokers; inline Jobs
  need no hook coverage because the agent child dies with the companion (its
  stdio pipes close and ACP agents exit on stdin close; the child is spawned
  attached, not detached).
- Residual risk: if the companion is SIGKILLed mid-turn, the agent child gets
  no `session/cancel` and exits only on stdin close; a stubborn agent that
  ignores stdin EOF can linger, and the Job record stays `running` until
  `consult cancel` observes the dead `runnerPid`. We accept this rather than
  building supervision.
- A Host that kills the terminal foreground process group kills the delegate
  turn with it. That is the intended semantics for foreground work; use
  `--background` for work that must survive the invoking session.
