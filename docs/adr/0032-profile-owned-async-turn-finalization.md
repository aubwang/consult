# Profile-owned async turn finalization

Status: Accepted

## Context

Consult treats an ACP `session/prompt` response as the terminal boundary for a
Job turn. The maintained Claude ACP adapter through 0.58.1 could return
`end_turn` after launching an asynchronous Claude `Agent`/`Task` while that
subagent and its promised follow-up were still running. Consult would then
record interim text such as "waiting" as a successful Job Result and dispose
the Job-scoped Profile process, making the real result undeliverable.

The adapter owns Claude SDK task identities, background-task bookends,
permission requests, autonomous follow-up results, cancellation, and idle
ordering. Its 0.59.0 lifecycle fixes hold `session/prompt` open while a turn's
background subagents remain live. Recreating that provider-specific state
machine in Consult Core would duplicate upstream behavior and create two
competing definitions of terminality.

## Decision

Profile adapters remain responsible for returning a terminal
`session/prompt` response only when the Profile turn is terminal.

Consult adds a narrow compatibility guard for the maintained
`@agentclientprotocol/claude-agent-acp` package. If a version older than 0.59.0
emits an explicit asynchronous `Agent`/`Task` launch and then returns a stop
reason, Consult finalizes the Job as failed with
`CLAUDE_ASYNC_FINALIZATION_UNSUPPORTED` and an exact adapter update command.
It does not publish the interim assistant text as a successful Result.

The guard does not reject normal turns or other Profile implementations by
version. Claude adapter 0.59.0 and newer retain full lifecycle ownership; no
Consult-side background-task emulation runs for them.

## Consequences

- Vulnerable adapters fail honestly at the affected feature boundary instead
  of producing a false successful Result.
- Updating the Claude adapter restores asynchronous subagents without changing
  Consult configuration or Job prompts.
- Consult Core stays independent of Claude SDK task bookkeeping and does not
  consume private SDK lifecycle messages.
- If a future maintained adapter regresses this contract under a newer version,
  Consult needs new compatibility evidence rather than silently expanding the
  old version range.
