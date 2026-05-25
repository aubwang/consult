---
description: List configured Consult profiles, optionally set the default
argument-hint: '[--set <name>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" agents $ARGUMENTS`
