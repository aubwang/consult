---
description: Cancel an active Consult job (sends ACP session/cancel via the broker)
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" cancel $ARGUMENTS`
