# TypeScript on native Node type stripping

Status: Accepted

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

- `engines.node` rises from `>= 22` to `>= 24`, superseding the floor noted in
  ADR 0019; type stripping is default-on only from Node 23.6.
- The Claude Code session lifecycle hook (`session-lifecycle-hook.mts`) now
  requires Node >= 24 on Host machines.
- Only erasable TypeScript syntax is allowed: no enums, namespaces, parameter
  properties, or decorators.
- Runtime validation (`isRecord` checks etc.) remains authoritative for data
  crossing process and disk boundaries; types complement it, never replace it.
- CI runs `tsc --noEmit` plus the unchanged `node --test` suite over `.mts`
  files.
