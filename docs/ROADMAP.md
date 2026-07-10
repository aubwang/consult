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
- Canonical Job Authority defaults delegation to read-only native confinement,
  with explicit write, fetch, and ambient-inheritance grants.
- Built-in Codex and Claude confinement targets native Linux and macOS with
  direct-network denial, authenticated pinned-address proxying, minimal staged
  credentials, exact Profile preflight, and process-tree cleanup.
- Custom and opencode Profiles are explicit-inherit only. Native Windows and
  confined nesting are unsupported.
- Execute permission remains fail-closed pending execute-specific resource
  containment and cross-Profile conformance.
- Scoped npm releases ship as `@aubwang/consult`; GitHub-clone installation is
  not a supported distribution path.

Consult no longer ships a Claude Code plugin/Host Adapter. The Claude Profile
is still supported. Gemini and GitHub Copilot are not supported Profiles.

## Release Hardening

Before graduating portable Job Authority as the default release boundary:

- Run fresh direct, foreground, background, isolated-write, fetch,
  cancellation, and resume probes for every claimed Profile/OS confinement
  combination. Flip support per combination; do not infer one from another.
- Record the product-level macOS Codex and Claude controls from an unrestricted
  terminal, plus fail-closed nested results from already-confined Hosts. The
  existing macOS spike is evidence, not the final adapter conformance run.
- Re-run Linux Codex and Claude read/write/fetch/direct-egress/cleanup probes
  against the packed artifact.
- Validate package installation through both npm and Bun from a packed tarball.
- Document any Profile-specific differences that remain observable through the
  common Job result contract.
- Decide and document the compatibility policy for future Job-result schema
  versions.

## Near-Term Follow-Ups

- Add an explicit, safe patch-application command only if real use shows that
  surfacing the patch path is insufficient. Keep application user-controlled.
- Add retention and cleanup policy for old Job logs and isolated artifacts.
- Add process-count, CPU, memory, and disk containment only after a portable
  resource-authority design is proven; wall-clock and log-size limits already
  ship.
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
- A credential broker. Credentials remain process-tree readable and
  egress-constrained; `--allow-fetch` documents the resulting exfiltration
  risk instead of hiding it behind a complex broker.
- Native Windows support. WSL2 follows the Linux path; native Windows has no
  confinement or inheritance surface.
- A new Claude Code plugin surface. Host-specific UI is outside the current
  product vision.
