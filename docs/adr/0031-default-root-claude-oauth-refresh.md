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

## Amendment: proactive near-expiry refresh

The refresh trigger is widened from *already expired* to *expired or expiring
within a skew window*. A stageable OAuth credential that is still valid at
preflight but within the skew is treated as refresh-eligible, so a root Job
refreshes it before staging rather than letting it lapse between staging and
the first confined model call (the confined Job stages a fixed snapshot and its
egress allowlist — `api.anthropic.com` only — cannot reach the token endpoint,
so it never self-refreshes).

The skew defaults to two minutes and is configurable through
`CONSULT_CLAUDE_OAUTH_REFRESH_SKEW_MS`; `0` restores the strict already-expired
behavior. It is kept small on purpose: a credential within the window is close
enough to expiry that the Host refresh session reliably rotates it, and the
existing single-retry guard still fails closed with `claude setup-token` /
`CONSULT_CLAUDE_OAUTH_TOKEN` remediation when a refresh does not extend it.

Doctor stays observational under this amendment: it classifies the credential
with a zero skew (`inspectClaudeHostOauth`) so a still-valid, soon-to-expire
credential is reported as `expiring` without flipping `canDelegate`, and it
never performs the refresh. The durable operator fix remains an explicit
long-lived Consult credential variable, which bypasses the OAuth file entirely.
