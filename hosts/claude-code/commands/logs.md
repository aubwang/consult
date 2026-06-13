---
description: Print or follow rendered logs for a Consult job
argument-hint: '<job-id> [--follow] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" logs $ARGUMENTS`
