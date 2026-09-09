# ADR 0044: Model and configured Profile discovery

## Status

Accepted.

## Decision

Keep `capabilities` as a static build description by default. Add an explicit
`--configured` form that reads Profile configuration and returns compact route,
authority, and invocation information without starting agents. Preserve the
existing `agents --json` array contract.

Add `consult models` for live model enumeration. Standard opencode Profiles use
the configured executable's native catalogue command; other Profiles use ACP
Session model metadata. Confined initialization remains the default for Codex
and Claude. Inherited ACP initialization requires an explicit Profile and
`--sandbox inherit`. The native opencode metadata command runs with Host
authority, as its existing catalogue interface does. Neither path sends a model
prompt, refreshes Host login, or creates a Consult Job.

Reuse the exact Profile launch and preflight teardown paths for ACP discovery.
Probe confined Profiles sequentially because the pinned runtime owns global
process state. Bound Session creation and native catalogue output. Report
failures per Profile without echoing arbitrary backend stderr.

Every discovery envelope identifies the running Consult version. Model results
carry exact IDs, configured Profile keys, source, confinement requirements, and
argument arrays. The Host supplies the executable and sends its prompt on stdin.
Model IDs are matched literally by case-insensitive substring, with bounded
pages. Discovery never changes selection defaults, picks a different model, or
grants inherited authority automatically.

## Consequences

An agent can discover the route to a requested model through Consult without
reading all help topics or learning each provider's catalogue command. The
configuration-only summary works outside a Git repository; live discovery uses
the current Workspace and may create backend-owned session state.

Catalogue membership does not establish account entitlement, readiness, or
successful inference. Results distinguish advertised models from verification,
retain partial successes, and provide Doctor arguments for failed probes.
Explicit-inheritance requirements are visible even when the probe was skipped.
No persistent model cache is introduced; scoped `--agent` discovery avoids
unrelated probes when the Host already knows the route.


## Native route preference amendment

Default discovery directs Claude families to configured Claude ACP Profiles and
OpenAI families to configured Codex ACP Profiles. It identifies Profiles by
registry identity, preserving configured aliases. Family-level searches inspect
only the native catalogue. Broader searches exclude recognized alternative
Claude/OpenAI routes even when the native Profile is unavailable. Missing native
configuration and failed native probes retain their setup/Doctor diagnostics.

An explicit `--agent` selection overrides the discovery preference and exposes
that Profile's own catalogue. No model IDs are translated between adapters.
Configured capabilities carries the same routing guidance so a calling Host
can select the native route without first enumerating models. The user can
still deliberately choose opencode or another configured Profile.
