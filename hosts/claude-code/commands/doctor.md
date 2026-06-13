---
description: Diagnose whether Consult can delegate from this workspace
argument-hint: '[--agent <name>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" doctor $ARGUMENTS`
