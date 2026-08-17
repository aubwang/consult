# GitHub Copilot CLI as a built-in inherit-only Profile

Status: Accepted

Consult adds `copilot` as a fourth built-in Profile definition. The GitHub
Copilot CLI (`@github/copilot`, npm) serves the Agent Client Protocol natively
via `copilot --acp`, so the registry entry launches the CLI itself — there is
no separate `*-acp` shim and no lazily spawned inner CLI to pin (the ADR-0036
problem does not apply).

ADR-0022 removed the earlier Copilot Profile definitions when Copilot had no
ACP surface worth a conformance matrix seat. That constraint has changed:
Copilot CLI's ACP server is a first-party, documented mode (public preview
since 2026-01-28). This ADR amends ADR-0022's built-in Profile list; the
CLI-only product scope is unchanged, and Gemini remains unsupported.

The Profile is **inherit-only**, at the same support level as opencode:

- `CONFINED_PROFILE_POLICIES` gains no `copilot` entry. Default confined
  `delegate`/`review` fails preflight with `confined authority is unsupported
  for Profile registry identity 'copilot'` and creates no Job. Confinement for
  copilot requires its own decision: credential-file staging semantics, the
  Copilot model-endpoint egress allowlist, and a read-only mode pin have not
  been designed or conformance-tested.
- `PROFILE_LAUNCH_POLICIES` also stays null, so the legacy
  `CONSULT_AGENT_SANDBOX=bwrap` path mounts no Copilot config; it is
  undocumented and untested for this Profile.

Registry decisions, verified against `@github/copilot` 1.0.80:

- `args` stay minimal (`["--acp"]`); no `--available-tools`/`--excluded-tools`
  pre-constraint. Consult's cooperative read-only policy already denies
  edit/execute permission requests, and Copilot's permission options use
  spec-standard `allow_*`/`reject_*` kinds that Consult's option picker
  understands.
- `supports.load: true` mirrors the advertised `loadSession` capability;
  `supports.resume: false` because no resume session capability is advertised.
- ACP `initialize` answers in well under Consult's timeout and advertises
  `authMethods` instead of blocking on a TTY when logged out; an
  unauthenticated turn fails fast with `-32000: Authentication required`.

Copilot CLI is a Profile, not an autodetected Host. Static inspection of
1.0.80 shows it reads `COPILOT_AGENT_SESSION_ID` as an input and exports
per-session identifiers only to its own internal detached child sessions, so
spawned processes see no stable session marker to detect. A Copilot spawning
Host passes `--host copilot --host-session <id>` or the `CONSULT_HOST` /
`CONSULT_HOST_SESSION_ID` environment values, like any custom Host. If a
future Copilot CLI exports a stable marker, autodetection can follow the
existing environment-based pattern (ADR-0017).

## Consequences

- Registry, help, setup, and docs list `claude`, `codex`, `opencode`, and
  `copilot` as built-ins; `consult setup --install copilot` installs or adopts
  the CLI and smoke-verifies its ACP handshake.
- Delegation requires an explicit `--sandbox inherit`; Jobs run with the
  Host's ambient authority and cooperative Job policy only.
- Setup verifies without a Copilot login, so first delegation failures are
  auth remediation (`copilot` + `/login`, or `COPILOT_GITHUB_TOKEN`), not
  install failures.
- Live conformance evidence at handshake level is recorded in
  `docs/conformance/copilot.md`; model-turn checks are auth-deferred and must
  pass before any confined-support follow-up.
