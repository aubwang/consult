# Versioned Job results and portable pinned review

Status: Accepted

Consult exposes Job JSON through an allow-listed schema-versioned envelope
rather than serializing mutable internal Job records. Schema version 1 contains
four top-level sections after `schemaVersion`: `job`, `outcome`, `artifacts`,
and `lineage`. New internal record fields do not become public accidentally.
Agent final text is accumulated from agent-message updates only; rendered tool
activity belongs in progress and log output.

Consult also owns deterministic diff capture. `delegate --include-diff
[--base <ref>]` resolves any base to a commit, captures the relevant staged and
unstaged material before the Job starts, applies a UTF-8-safe size bound, and
places it inside explicit untrusted-data delimiters. Background Jobs persist
the augmented prompt they actually execute.

`consult review` is Profile-neutral. Every review is a read-only,
findings-first Job over a Consult-pinned diff. Codex's verified native review
command may be used as an internal adapter optimization; Profiles without a
native review command use ordinary ACP delegation against the same input.

We chose this split because scripts and parent agents need a stable portable
contract, while Job records and Profile-native update formats necessarily
evolve. Deterministic input also matters more for agentic review than native
conversation continuity: the reviewer should assess one immutable change, not
whatever the working tree becomes later.

## Consequences

- Consumers must branch on `schemaVersion` and section names rather than parse
  internal records.
- JSON commands may add fields compatibly inside a schema, but breaking shape
  changes require a new schema version and migration guidance.
- Diff resolution errors occur before Job creation and are usage failures.
- The portable review path works for all configured Profiles; the old
  codex-only exit-code contract is removed.
- Diff text is treated as untrusted input, never as additional instructions.

This ADR supersedes the codex-only review consequences in earlier planning and
narrows ADR-0002's Profile-capability rule: native review remains optional,
while portable review is Consult Core behavior.
