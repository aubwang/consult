# Contributing to Consult

Start with [CONTEXT.md](CONTEXT.md) for the domain language and [AGENTS.md](AGENTS.md) for repository conventions. The CLI is the product interface. Shared behavior belongs in Consult Core; Host detection and Profile-specific handling should stay small.

## Work from source

```sh
git clone https://github.com/aubwang/consult.git
cd consult
bun install --frozen-lockfile
./bin/consult help
bun run typecheck
bun run test
```

Node runs the erasable TypeScript source directly. `./bin/consult` prefers source in a checkout, so an old `dist/` directory cannot hide your edits. Published packages run compiled JavaScript. Use `bun run pack:check` to check the installed package; `CONSULT_PACKAGE_SMOKE_CONFINED=1 bun run pack:check` also runs the deterministic confinement matrix and needs working platform sandbox dependencies.

Tests use Node's test runner. For a focused check, run `node --test scripts/lib/<file>.test.mts`. Use `bun run test` for the suite, rather than Bun's own test runner.

## Propose a change

Describe the concrete behavior that needs to change and how someone can verify it. Include a regression test for a bug with meaningful failure conditions. A new Profile needs evidence for initialization, permissions, cancellation, authentication, and any resume behavior it advertises. Keep live credentials and private project material out of fixtures and reports.

Update CLI help and relevant documentation when behavior changes. Record architectural decisions in `docs/adr/`. Changes to the versioned Job Result contract must follow its compatibility rules. Provider capability differences belong behind that common result shape.

Tests distinguish a completed agent turn from a verified implementation. Preserve that distinction in examples and output. Preserve recoverable work when cleanup or artifact capture fails.

Use a focused branch and a pull request. Conventional Commit titles such as `fix: preserve isolated work after patch failure` help the release workflow. Releases run through release-please; contributors should not bump versions or publish packages manually.

Local agent notes and session state are untracked. Contributor instructions should work from a fresh checkout without a particular agent's local tools.
