# Node 22.18 runtime floor

Status: Accepted

ADR 0020 raised `engines.node` from `>= 22` to `>= 24` on the grounds that
native type stripping was default-on only from Node 23.6. That reasoning is no
longer correct: type stripping was backported and is default-on from Node
22.18.0, so the constraint that justified the 24 floor has moved.

An audit of the runtime surface found nothing that requires Node 24. No
ECMAScript feature and no Node API introduced after 22.0 is used anywhere in
`scripts/`, `bin/`, or the published `dist/`, and no code asserts a runtime
version. The compiled package is even more portable than the checkout, because
it ships plain `.mjs` and needs no stripping at all.

The floor is therefore the checkout requirement, not an API requirement:
`>= 22.18.0`, the first release that runs `.mts` sources unflagged. Declaring
`>= 22` would be wrong in the other direction — 22.0 through 22.17 cannot run a
checkout at all.

Two defects blocked the suite on Node 22 and are fixed alongside this change.
Both are the same shape: an unref'd handle awaited inside a pending promise.
Node 22's test runner cancels a test when the event loop drains with a promise
outstanding, where Node 24 keeps it alive. The Host OAuth refresh timeout was
unref'd, which also made it an unreliable production guard — an unref'd timer
only fires while something else holds the loop open, so the timeout stopped
guarding exactly when the refresh went quiet.

## Consequences

- `engines.node` is `>= 22.18.0`. This supersedes the floor consequence in
  ADR 0020 and the `>= 24` statements in ADR 0019.
- CI runs the suite on both 22 and 24. The matrix is the guard: `@types/node`
  tracks a much newer Node than the floor, so the typechecker will not reject a
  post-22 API on its own.
- Contributors need 22.18+ because a checkout executes `.mts` directly.
  Installed users run compiled `.mjs` and are not bound by the stripping
  requirement, so the manifest floor is stricter than the published artifact
  strictly needs.
- Timers awaited inside a race must not be unref'd. Where a handle is
  deliberately being waited on, it has to hold the event loop open, and the
  wait needs a `clearTimeout`/`unref` pair only after it has been settled.
