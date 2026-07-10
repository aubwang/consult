# CLI-only product scope and reduced built-in Profile set

Status: Accepted

Consult's shipped product interface is the single `consult` CLI plus optional
agent skills that invoke it. We remove the Claude Code plugin manifest, slash
commands, subagent, lifecycle hook, root plugin symlinks, and the
`hosts/claude-code` Host Adapter. We also stop autodetecting
`CLAUDE_SESSION_ID`. Codex and opencode remain environment-detected Hosts;
terminal and explicit custom Host identities remain valid.

This does not remove Claude as a Profile. `claude-agent-acp` remains one of the
three built-in Profile definitions alongside `codex-acp` and `opencode acp`.
The Gemini and GitHub Copilot Profile definitions, installers, convenience
skills, tests, and conformance pages are removed. Generic custom Profile
configuration remains available without making those agents supported product
defaults.

The old plugin surface made Consult's Host-neutral delegation model feel like
an accessory inside one Host and duplicated a CLI that already works from
agent shells. Product focus is agentic delegation across environments, not
user-level UI parity with every Host. A smaller conformance matrix also lets us
hold the built-in Profiles to a stronger write-safety and result-contract bar.

## Consequences

- Installation produces one `consult` binary; the repository is not a valid
  Claude Code plugin directory.
- Claude users may still be delegated to through the Claude Profile and may
  expose the generic Consult skill in a Host manually.
- `CONSULT_HOST=claude-code` remains a valid explicit custom Host value for old
  records and tests; it is no longer inferred from Claude environment state.
- Registry, help, setup, docs, and convenience skills list only `claude`,
  `codex`, and `opencode` as built-ins.
- New Host-specific UI requires a new product decision. It must not silently
  reintroduce parallel command behavior.

This ADR supersedes ADR-0014's requirement for a Claude Host Adapter,
ADR-0017's Claude Host autodetection, ADR-0018's shipped Host-adapter
entrypoints, and the Claude lifecycle consequences in ADR-0021. Their
historical rationale remains useful; this records the current scope.
