---
description: Show the Delegation Chain rollup for a Consult job
argument-hint: '<job-id> [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" chain $ARGUMENTS`
