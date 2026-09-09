# ADR 0045: Pass explicit Claude model pins at startup

Status: Accepted

## Context

The native Claude adapter's default model picker is not an exhaustive list of
models it can run. Consult passed only hardcoded aliases to the confined
adapter at startup. As a result, `fable` worked while `fable 5.1` failed local
picker validation before the provider could receive the requested model.

## Decision

Keep existing aliases compatible. Also accept explicit native `claude-*` IDs
as startup model pins, preserving their spelling, and expand versioned Claude
family shorthand using hyphens between version components. For example,
`fable 5.1` and `fable-5.1` expand to `claude-fable-5-1`.

The existing confined launch passes the pin through `ANTHROPIC_MODEL`. Session
controls still validate and select against the resulting session metadata.
This does not bypass adapter validation, infer model entitlement, or change the
Profile. Explicit versions never fall back to another version or provider.

## Consequences

New version pins and explicit native IDs no longer require new hardcoded
aliases. Discovery still reports only advertised models; absence from that
catalogue is not a definitive availability check. Live verification must check
the model recorded in the native transcript, not merely a successful response.
