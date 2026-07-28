# ADR 0034: Confined read scopes follow the Profile agent's declared dependencies

## Status

Accepted.

## Decision

For a Profile agent that is a Node script, Consult grants confined read scopes
for the agent's declared dependency closure — `dependencies` and
`optionalDependencies`, walked transitively — in addition to the agent's own
package directory.

Consult resolves each dependency through the same `node_modules` lookup the
agent itself will use, rather than `require.resolve`, which an `exports` map can
refuse for `package.json` even though the package directory is exactly what must
be mapped. Dependencies that do not resolve on disk are skipped. The closure is
bounded by `MAX_NODE_DEPENDENCY_READ_SCOPES`; exceeding it warns and truncates
instead of mapping an unbounded tree.

## Rationale

Confined read scopes previously covered the agent executable, its directory, and
its owning npm package. That is sufficient only when the agent's dependencies
happen to be nested beneath it or to sit under an already-readable system path.

Package managers do not guarantee either. A Homebrew or user-level npm prefix
hoists dependencies to a shared `node_modules` root beside the agent, outside
both the agent's package directory and `/usr`. `codex-acp` resolves
`@openai/codex/bin/codex.js` at startup — before it answers ACP `initialize` —
and that package in turn resolves a platform-specific package holding the native
Codex binary. Under a hoisted layout both were unreadable inside confinement, so
the agent exited on `MODULE_NOT_FOUND` with empty stdout. Consult reported only
`AUTHORITY_PREFLIGHT_FAILED: Agent exited before initialize completed`, which is
indistinguishable from a broken or protocol-drifted shim.

The declared closure is the narrowest boundary that is also correct. Granting
the enclosing `node_modules` root would fix the same failure by exposing every
package installed under that prefix, including packages unrelated to the Profile.
Keeping the grant to what the agent declares means the confined surface is a
property of the agent, not of where its package manager chose to put things.

Skipping unresolvable dependencies is required rather than lenient: npm installs
only the current platform's entry from a set of platform-specific
`optionalDependencies`, so the absent ones are expected and must not fail a
launch.

## Consequences

Read scopes now depend on the agent's installed dependency tree, so the same
Profile can map a different set on two Hosts. That is intended — it mirrors what
the agent will actually resolve. Agents whose dependency closure exceeds the
bound are not silently confined into failing; they warn.
