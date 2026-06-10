---
description: Run the Profile's review slash via Consult (codex-only in v1)
argument-hint: '[--agent codex] [--base <ref>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" review $ARGUMENTS`
