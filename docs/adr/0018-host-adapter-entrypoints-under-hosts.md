# Host Adapter entrypoints live under hosts

Status: Accepted

Consult keeps **Consult Core** in `scripts/`, `bin/`, and shared `skills/`, while
Host-specific adapter packaging lives under `hosts/<host>/`.

The Claude Code adapter owns its native plugin surface under
`hosts/claude-code/`: `.claude-plugin/`, `commands/`, `agents/`, `hooks/`, and
its lifecycle hook script. Root-level `.claude-plugin`, `commands`, `agents`,
and `hooks` are tracked symlinks to those canonical files because Claude Code
expects plugin entrypoints at the plugin root.

We chose this because Claude Code has richer native plugin mechanics than Codex,
opencode, or terminal use, but those mechanics should read as one **Host
Adapter** rather than the spine of the product. **Consult Core** remains
host-neutral and **Host Adapters** stay thin.

Consequences:

- Future Host-specific files should start under `hosts/<host>/`.
- Root Claude Code paths are packaging entrypoints, not the canonical
  implementation location.
- Tests for Host-specific scripts live with the Host Adapter; the package test
  glob includes `hosts/**/*.test.mjs`.
