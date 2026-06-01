# Gemini CLI ACP Conformance

Status: unit-covered, live conformance pending local Gemini CLI authentication.

Backend: Gemini CLI native ACP mode (`gemini --acp`).

## Implementation Notes

Consult treats Gemini CLI as a normal Profile. Unlike Codex and Claude, it does
not need a separate ACP shim: Gemini CLI starts its JSON-RPC-over-stdio ACP
server directly with `--acp`.

Setup installs or discovers the `gemini` binary from the `@google/gemini-cli`
npm package, smoke-probes ACP initialize, and persists the Profile with
`args: ["--acp"]`.

## Sandboxing

For `CONSULT_AGENT_SANDBOX=bwrap`, Consult mounts selected Gemini auth/config
files read-only from host home into `/tmp/.gemini`:

- `settings.json`
- `oauth_creds.json`
- `GEMINI.md`
- `mcp-oauth-tokens.json`
- `a2a-oauth-tokens.json`

The sandbox home remains writable so Gemini can create runtime state such as
`tmp`, `history`, and project registry files. For Vertex AI service-account
flows, `GOOGLE_APPLICATION_CREDENTIALS` is also mounted read-only when it points
to an existing file.

## Deferred Live Checks

Live setup/delegate/read-only/write/cancel/load checks are pending a local Gemini
CLI login or API key. The registry and sandbox launch behavior are covered by
unit tests.
