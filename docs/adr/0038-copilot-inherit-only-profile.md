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

The Profile ships as **preview support**: the handshake-level behavior below
is live-verified, while the model-turn conformance matrix is auth-deferred
(`docs/conformance/copilot.md`). ACP mode itself is a GitHub public preview.

Launch and policy decisions, verified against `@github/copilot` 1.0.80:

- The registry entry stays `["--acp"]`, but every launch appends Job-mode
  `--deny-tool` pins (`profileModeArgs`): the `shell` and `url` permission
  kinds are always denied, and `write` is denied unless the Job grants
  writes. Web fetches request the `url` permission kind — `web_fetch` is a
  tool name, not a permission kind, and denying it does not block fetches.
  Copilot ranks deny rules above `--allow-all`, `COPILOT_ALLOW_ALL`, and
  approvals saved in `~/.copilot`, so the pins hold even when persisted or
  ambient state would auto-approve tools without a
  `session/request_permission` round-trip. The launch also deletes
  `COPILOT_ALLOW_ALL` from the child environment (`profileStripEnvKeys`) —
  the variable binds to the boolean `--allow-all-tools` option, and any
  defined value, including empty, enables it — and pins `--no-auto-update`
  so the verified binary cannot swap itself out mid-Job.
- Delegated launches refuse Copilot CLI builds older than 1.0.60
  (`copilotAgentVersionDiagnostic`, enforced at setup, preflight, and every
  turn): ACP permission flags landed at 0.0.400, but ACP-mode permission
  behavior kept consolidating until 1.0.60, so an older binary can accept
  the pins without honoring them. The check fails closed: agentInfo is
  optional in ACP, so a copilot-identity Profile whose agent omits or
  renames it is refused as unverifiable, while an agent that reports the
  Copilot identity is enforced under any Profile name.
- The pins bound model-initiated tool calls only. Copilot's user- and
  repository-configured hooks, custom instructions, and MCP servers execute
  with the Host's ambient authority outside the `shell` permission — during
  Jobs and during preflight's throwaway session alike. That is the accepted
  inherit-tier boundary (same as opencode plugins); bounding those sources
  requires the confined-tier isolation this ADR defers.
- `supports` is `{resume: false, load: false}` and both `--resume` selectors
  are rejected (`profileRejectsResume`) even though the agent advertises
  `loadSession: true`: Copilot persists tool approvals across sessions, and a
  loaded Session would restore permission state wider than the new Job's
  authority. Reopening stays rejected until that state is bounded.
- Inherited preflight creates a throwaway session (`profilePreflightsSession`)
  because Copilot's `initialize` succeeds while logged out and only
  `session/new` raises `Authentication required`; doctor and delegation now
  fail an unauthenticated Profile before Job creation, without a model prompt.
- Copilot maps model/provider failures to plain `"Error: ..."` message chunks
  and still stops with `end_turn`; Consult fails such turns with
  `COPILOT_MODEL_ERROR` instead of persisting the outage as a successful
  Job Result. Known provider-error signatures are matched against the
  assembled turn text, anchored to its end (indented continuation lines
  allowed), so a recovered or quoted error followed by a real answer still
  completes. This is a heuristic pending structured errors upstream.
- ACP `initialize` answers in well under Consult's timeout and advertises
  `authMethods` instead of blocking on a TTY when logged out. Copilot's
  permission options use spec-standard `allow_*`/`reject_*` kinds that
  Consult's option picker understands.

Copilot CLI is a Profile only. Host autodetection was investigated and not
added: static inspection of 1.0.80 shows it exports no stable session marker
into spawned processes (`COPILOT_AGENT_SESSION_ID` is read as an input, and
per-session identifiers reach only its own internal detached child sessions).
If a future Copilot CLI exports a stable marker, autodetection can follow the
existing environment-based pattern (ADR-0017).

## Consequences

- Registry, help, setup, and docs list `claude`, `codex`, `opencode`, and
  `copilot` as built-ins; `consult setup --install copilot` installs or adopts
  the CLI and smoke-verifies its ACP handshake.
- Delegation requires an explicit `--sandbox inherit`; Jobs run with the
  Host's ambient authority and cooperative Job policy, hardened by the
  `--deny-tool` pins and the `COPILOT_ALLOW_ALL` guard above.
- Setup verifies without a Copilot login; doctor and delegation preflight
  create a session and fail an unauthenticated Profile with auth remediation
  (`copilot` + `/login`, `COPILOT_GITHUB_TOKEN`, or a `COPILOT_PROVIDER_*`
  BYOK configuration), not install failures.
- Live conformance evidence at handshake level is recorded in
  `docs/conformance/copilot.md`; model-turn checks are auth-deferred and must
  pass before any confined-support follow-up.
