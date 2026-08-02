# ADR 0036: Setup pins a reachable Codex binary

## Status

Accepted.

## Decision

Consult setup verifies that an installed or adopted `codex-acp` can actually
reach a Codex CLI before the codex Profile is written to disk.

Setup first mimics the adapter's own resolution: it resolves
`@openai/codex/bin/codex.js` with `module.createRequire` anchored at the
adapter binary's **real** path. If that succeeds the adapter carries its own
Codex, and Consult records nothing further.

If it fails, setup detects an existing Codex CLI — `codex` on PATH, then
`~/.local/bin/codex` — requiring each candidate to be executable, realpath'ing
it, and running a `<candidate> --version` handshake that must exit 0 within
five seconds and print a `\d+\.\d+\.\d+` version. The first candidate that
passes is recorded on the Profile record as `codexPath` (with `codexVersion`
for diagnostics). If no candidate passes, the install fails at a `codex-runtime`
stage with a message naming all three remediations: reinstall the adapter with
its bundled Codex, install `@openai/codex` next to the adapter, or make a
working `codex` binary available on PATH.

At launch time every path derives `CODEX_PATH` from that recorded value alone —
confined, legacy bubblewrap, and ambient. Consult never scans PATH at launch and
never reads an ambient `CODEX_PATH`: in the confined path the child environment
is built from scratch, so a Host `CODEX_PATH` is scrubbed like any other
unlisted variable; in the ambient and legacy paths the computed value is applied
last and overrides whatever the Host set. A confined launch whose recorded
`codexPath` has since gone missing or lost its exec bit fails closed rather than
falling back.

Confined read scopes for the pinned binary are deliberately narrow: the
realpath'd file, the symlink ancestors needed to traverse the configured path,
and the binary's linked runtime closure (ELF/`ldd` on Linux, Mach-O/`otool` on
macOS). The parent directory is **not** granted, which is why this uses its own
`pinnedExecutableReadScopes` helper rather than `runtimeExecutableReadScopes`:
the latter adds `path.dirname` so a Profile agent can reach files packaged
beside it, and applying that to `~/.local/bin/codex` would hand the confined
Profile every other tool the user keeps in that directory. The legacy bubblewrap
path likewise binds the pinned file alone, not its directory.

## Rationale

codex-acp reads `CODEX_PATH` and spawns `<CODEX_PATH> app-server` when it is
set. When it is unset it falls back to resolving `@openai/codex/bin/codex.js`
through the npm tree around itself. That fallback only works when
`@openai/codex` is installed in a `node_modules` tree reachable from the
adapter, which is precisely what the standalone compiled adapter distributions
(built with `bun --compile`) do not have.

Consult's own setup actively creates the broken configuration. Its shell-install
branch probes PATH for an existing `codex-acp` first — existing binary wins —
and only runs `npm install -g` when none is found. A machine with a standalone
codex-acp on PATH and a standalone `codex` at `~/.local/bin/codex` therefore
ends up with an adopted adapter that has no npm tree to resolve through and no
knowledge of the Codex binary sitting a directory away.

The failure is lazy, which is what made it expensive. codex-acp does not spawn
Codex during the ACP handshake, so `initialize` succeeds even when no Codex is
reachable anywhere. Consult's setup smoke test is exactly that handshake, so it
happily registered a dead Profile, and the user only discovered it later as an
opaque failure at delegate time, inside a Job, far from the install that caused
it. Deciding reachability at setup moves the diagnosis to the moment the user
can act on it, and refusing to persist keeps a known-dead Profile out of the
Profile store entirely.

Recording the detected path rather than re-detecting at launch follows the same
posture as ADR-0035: which Codex a delegate runs is authority-shaped
configuration, so it is computed once from a trusted recorded value and replayed,
never inferred from ambient state at the launch boundary. Runtime PATH-scanning
would make the answer depend on whatever environment happened to spawn the
broker, and an inherited `CODEX_PATH` would let the Host substitute an arbitrary
executable into a confined Job.

Anchoring the bundled-resolution probe at the adapter's realpath is the same
lesson as ADR-0034: npm global bins are symlinks into the package tree, so
resolution that starts at the symlink walks the wrong `node_modules` chain and
reports a false negative.

## Consequences

`consult setup --install codex` now fails on machines where the adapter cannot
reach a Codex CLI, instead of registering a Profile that dies at the first
delegated session. Machines with a detectable Codex install are repaired
automatically and silently: the pin is recorded and every launch path uses it.
Because `consult doctor` runs the same live Profile launch through the preflight
path, the pin is exercised there too.

The codex Profile record gains two optional fields (`codexPath`,
`codexVersion`); absent fields keep the previous meaning of "the adapter
resolves its own Codex", so existing Profile records stay valid and need no
migration. A recorded pin is not self-healing — if the user removes or moves the
pinned binary, confined launches fail closed with a message pointing back at
`consult setup --install codex` rather than silently reverting to the npm
fallback that would fail later and less legibly. Non-codex Profiles are
unaffected on every path.
