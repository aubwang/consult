---
description: Show Consult job status (all jobs in this workspace, or one by id)
argument-hint: '[<job-id>] [--wait|--follow] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mts" status $ARGUMENTS`
