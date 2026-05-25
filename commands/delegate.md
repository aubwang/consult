---
description: Delegate a task to a configured Consult Profile (default profile or --agent <name>)
argument-hint: '[--agent <name>] [--write|--read-only] [--resume|--resume-job <id>|--fresh] [--parent-job <id>] [--model <m>] [--effort <e>] [--background|--wait] <prompt>'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `consult:delegate` subagent via the `Agent` tool (`subagent_type: "consult:delegate"`), forwarding the raw user request as the prompt.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `consult:delegate` subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground for short bounded asks; choose background for open-ended multi-step work.
- If the request does not include `--write`, delegate in read-only mode.

The subagent is a thin forwarder: one Bash call into `node "${CLAUDE_PLUGIN_ROOT}/scripts/consult-companion.mjs" delegate ...` with `$ARGUMENTS` preserved (minus `--background`/`--wait`). Return the companion stdout verbatim.
