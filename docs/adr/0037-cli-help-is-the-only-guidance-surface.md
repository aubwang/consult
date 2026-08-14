# CLI help is the only guidance surface

Status: Accepted

Consult's product surface is the `consult` CLI alone. The delegation judgment
that shipped as agent skills — when a handoff pays for itself, how to write a
prompt that survives having no conversation behind it, which authority to grant,
how to treat a delegate's answer — now lives in `consult help` and is disclosed
progressively. We remove `skills/`, the tracked `.opencode/skills/` entrypoints,
the `skills/` entry in the published package file list, and the
`npx skills add aubwang/consult` installation path.

`consult help` prints one screenful: the commands, the topics, and where to
start. Depth lives behind `consult help <topic>` for the eight topics
(delegation, authority, profiles, review, jobs, chains, contracts, guardrails),
and `consult help <command>` resolves the same per-command usage as
`consult <command> --help`. `consult help --all` prints everything for a Host
that wants the contract preloaded rather than fetched on demand.

We also remove the split between a human-facing summary and an agent-facing
`consult help --reference` dump. There is one help system; the reader chooses
depth by naming a topic rather than by matching a flag to their species.
`--reference` remains an undocumented alias for `--all` so an already-installed
Host that types the old spelling still gets output.

Skills were a second surface carrying a copy of the CLI's contract. They could
disagree with the installed binary, they had to be installed per agent and per
project while the CLI is installed once and globally, and every behavior change
meant editing the same facts in two places. Folding them into the binary makes
the guidance version-locked to the code it describes: an agent that runs
`consult help` is reading the CLI it is about to invoke.

## Consequences

- The npm package ships `bin/` and `dist/` only. There is nothing to install
  into an agent's skill directory.
- A Host learns Consult exists from the user's own instruction file
  (`AGENTS.md`, `CLAUDE.md`, a system prompt) pointing at `consult help`. README
  and `docs/USAGE.md` give that one-line pointer. Consult does not install
  itself into a Host's context.
- Help content is product behavior, not documentation. It is tested: topic
  pages must be registered, listed in the overview, individually bounded in
  length and line width, and must carry the contract details the reference dump
  used to hold.
- A name shared by a command and a topic resolves to the topic; `review` is the
  only current overlap.
- Docs stay the long-form companion for humans. When they disagree with
  `consult help`, the CLI is authoritative for the installed version.

This ADR supersedes the "plus optional agent skills" scope in ADR-0022 and the
convenience-skill consequences in ADR-0017 and ADR-0027. The CLI-only product
scope those ADRs established is unchanged; this removes the last surface that
was not the CLI itself.
