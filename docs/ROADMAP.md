# Consult Roadmap

This file tracks pre-release product direction. Accepted architectural choices
live in `docs/adr/`; this is not a second decision log.

## Current Product

Consult is a CLI-first, host-neutral delegation layer for agentic work:

- One `consult` CLI from terminal, Codex, or opencode.
- Built-in `claude`, `codex`, and `opencode` Profiles plus generic custom
  Profile configuration.
- Foreground and background Jobs with durable status, logs, cancellation,
  resume, and Delegation Chain lineage.
- Versioned Profile-neutral Job JSON with outcome and artifact sections.
- Deterministic pinned-diff delegation and Profile-neutral review; Codex's
  native review path remains an internal optimization.
- Transactional isolated write Jobs that return a patch and touched-files
  manifest without changing the invoking checkout.
- Execute permission is fail-closed while the existing bubblewrap backend lacks
  direct-network isolation and enforced proxy transport.
- One-command GitHub installation now; scoped npm publication packaging is
  ready for a future registry release.

Consult no longer ships a Claude Code plugin/Host Adapter. The Claude Profile
is still supported. Gemini and GitHub Copilot are not supported Profiles.

## Release Readiness

Before the first published npm release:

- Run fresh direct, foreground, background, isolated-write, cancellation, and
  resume probes for all three built-in Profiles.
- Run the bubblewrap matrix on Linux, including explicit execute opt-in and
  outside-workspace rejection.
- Validate package installation through both npm and Bun from a packed tarball.
- Document any Profile-specific differences that remain observable through the
  common Job result contract.
- Decide and document the compatibility policy for future Job-result schema
  versions.

## Near-Term Follow-Ups

- Add an explicit, safe patch-application command only if real use shows that
  surfacing the patch path is insufficient. Keep application user-controlled.
- Add retention and cleanup policy for old Job logs and isolated artifacts.
- Improve Broker and worker crash diagnostics based on field failures rather
  than expanding permanent daemon machinery.
- Expand Host autodetection only where it remains environment-based and keeps
  the CLI as the sole product interface.
- Add new Profiles only after a repeatable ACP conformance pass. Do not restore
  deprecated Profile definitions merely because their CLIs expose an ACP mode.

## Deliberately Deferred

- Cross-Profile native conversation transfer. Agentic Jobs should receive
  self-contained prompts; ACP resume stays within one Profile.
- A proprietary Codex app-server dependency. Consult uses ACP and normal Git
  artifacts for portable behavior.
- Interactive mid-Job permission prompts. Modes and execute authority are
  chosen at command start.
- A new Claude Code plugin surface. Host-specific UI is outside the current
  product vision.
