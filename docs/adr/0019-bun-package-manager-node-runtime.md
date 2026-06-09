# Bun manages packages, Node remains the runtime

Status: Accepted

Consult uses Bun as its package manager and script runner: `bun install`
maintains the tracked `bun.lock`, and `bun link` exposes the local `consult`
binary from a checkout. Node.js (>= 22, declared in `engines`) remains the
execution runtime and the test runner: `bin/consult`, Brokers, and the test
suite all run under `node`, and the suite is `node --test`.

We chose this split because Bun is the standard package tooling for this
codebase's environments and installs are fast and lockfile-stable, while the
product's riskiest surface — Broker process lifecycle, unix sockets, signal
handling, ACP subprocess spawning — is built and verified against Node
semantics. `bun test` is Bun's own test runner, not a `node --test` host, so
swapping the runtime or test runner would carry real migration risk with no
product payoff.

Consequences:

- `bun.lock` is the tracked lockfile; `package-lock.json` is removed.
- Run the suite with `bun run test` (or `node --test ...` directly), never
  `bun test`.
- CI installs dependencies with Bun but executes the suite under the Node
  versions in the support matrix.
- The test script's glob arguments require Node >= 21; `engines.node` is
  `>= 22` to stay on supported release lines.
- Reversing this means regenerating `package-lock.json` and updating install
  docs, with no source changes.
