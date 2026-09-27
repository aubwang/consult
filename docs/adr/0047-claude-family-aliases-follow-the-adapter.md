# ADR 0047: Claude family aliases follow the installed adapter

Status: Accepted

## Context

ADR 0045 kept a hardcoded table that expanded bare Claude family aliases such
as `opus` to a fixed native ID before passing it to the confined adapter at
startup. Every new model release left that table stale (`opus` still pinned
`claude-opus-4-8` after Opus 5.5 shipped) until Consult itself was released
again. The native adapter already advertises alias rows (`opus`, `sonnet`,
`opus[1m]`, ...) and its bundled Claude Code resolves each to the newest model
in that family, so session controls were already switching to the alias row
after startup.

## Decision

Pass bare Claude family aliases, optionally decorated (`opus[1m]`), through to
the adapter at startup unchanged, normalized only for case and a `claude-`
prefix. The adapter and its Claude Code resolve the alias. Versioned shorthand
and explicit native IDs keep ADR 0045's behavior and never select a newer
model. The built-in table remains only as the fallback when an adapter
advertises no model catalogue.

## Consequences

New Claude models need no Consult change or release: updating
`@agentclientprotocol/claude-agent-acp` is enough. An outdated adapter resolves
`opus` to the newest model it knows, which may be older than the newest
available; request an explicit version (`--model 'opus 5.5'`) when an exact
model matters. Consult does not probe the adapter's alias resolution, since
ACP model metadata does not carry the resolved ID.
