# TypeScript on native Node type stripping

Status: Accepted; the Node floor consequence superseded by
[0033 Node 22.18 runtime floor](0033-node-22-18-runtime-floor.md)

Consult's source is strict TypeScript in `.mts` files executed directly by
Node.js native type stripping — there is no build step. `tsconfig.json`
enforces erasable-only syntax (`erasableSyntaxOnly`, `verbatimModuleSyntax`)
and `tsc --noEmit` is a typecheck gate in CI, not a compiler. `bin/consult`
stays plain JavaScript because extensionless entrypoints are not type-stripped;
it imports `.mts` modules directly.

We chose this because a checkout must stay directly runnable (`bun link` /
`npm link` expose `bin/consult` straight from the repo), and because most of
the codebase is hand-validated protocol and state plumbing where
machine-checked types catch drift between modules. A compile-to-`dist`
pipeline would break edit-and-run; using Bun as the runtime to get TypeScript
for free was rejected for the reasons in ADR 0019 — Broker process lifecycle,
sockets, and signal handling are verified against Node semantics.

Consequences:

- `engines.node` rose from `>= 22` to `>= 24` on the understanding that type
  stripping was default-on only from Node 23.6. It was backported to 22.18.0,
  and ADR 0033 returns the floor to `>= 22.18.0`.
- The Claude Code session lifecycle hook (`session-lifecycle-hook.mts`) requires
  a Host Node that strips types, now 22.18 or newer.
- Only erasable TypeScript syntax is allowed: no enums, namespaces, parameter
  properties, or decorators.
- Runtime validation (`isRecord` checks etc.) remains authoritative for data
  crossing process and disk boundaries; types complement it, never replace it.
- CI runs `tsc --noEmit` plus the unchanged `node --test` suite over `.mts`
  files.
