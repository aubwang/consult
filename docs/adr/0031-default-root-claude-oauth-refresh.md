# ADR 0031: Default root Claude OAuth refresh

## Status

Accepted.

## Decision

When exact confined preflight reports that a stageable Claude OAuth file is
expired, a trusted root `delegate` or `review` invocation automatically makes
one Host-side refresh attempt. Consult starts the exact configured built-in
Claude ACP Profile without confinement, opens one ACP Session far enough for
the Claude Agent SDK to initialize authentication, sends no model prompt, and
disposes the Profile. Consult then reruns the same confined preflight exactly
once and continues the original command only if it passes.

Automatic refresh is the default and has no flag, setting, or confirmation.
It is unavailable to nested Jobs and diagnostic commands. An explicit
`CONSULT_CLAUDE_OAUTH_TOKEN` or `CONSULT_CLAUDE_API_KEY` remains authoritative
and bypasses the Host OAuth file. Refresh failure, timeout, or an unchanged
expiry fails before Job creation with interactive-login remediation; Consult
never retries with inherited authority.

The refresh process owns Host credential mutation. Consult never copies a
credential or refresh-token rotation from a Job-private home back to the Host.

## Rationale

Requiring users to leave a failed Consult invocation, run Claude manually, and
retry is avoidable when Claude's existing refresh session is still valid. ACP
Session initialization provides a headless, no-model path that works for root
foreground, JSON, and background invocations without driving the interactive
Claude TUI. One verified retry bounds races and prevents refresh loops.

Nested agents cannot be allowed to mutate Host authentication state. Doctor
also remains observational so diagnostics do not repair the state they report.

## Consequences

- A root Claude delegation may mutate its trusted Host credential before a Job
  exists.
- A fully logged-out or revoked session still requires `claude auth login`.
- The refresh probe is time-bounded and may create transient Claude Session
  state, but it sends no prompt and receives no model response.
- The confined Job continues to receive only a private credential snapshot and
  sanitized environment.
