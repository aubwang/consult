---
description: Install / verify / select a Consult Profile (codex, claude, opencode, copilot)
argument-hint: '[--json]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" setup --json
```

Parse the JSON. Render a short status list with each registry entry's id, label,
installed state, default marker, and lastVerifiedAt when present.

Use AskUserQuestion to offer actions:

- For missing entries: `Install <id>`.
- For installed entries that are not default: `Set Default <id>`.
- Always include `Done`.
For each menu option, include the registry entry's notes (if present) in the option's description.

When the user chooses install, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" setup --install <id>
```

Surface stdout and stderr. Then run the JSON probe again and show the menu again.

When the user chooses set default, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" setup --set-default <id>
```

Surface stdout and stderr. Then run the JSON probe again and show the menu again.

Stop only when the user chooses `Done`.
