---
name: ask-codex
description: Ask a separate Codex Profile through Consult for a second review, critique, explanation, debugging hypothesis, or design opinion while working in Codex. Use when the user says to consult Codex, ask another Codex, get a Codex review, or use Codex as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should the separate Codex answer or review?
---

# Ask Codex Through Consult

Use this skill when the user wants a separate Codex Profile opinion through
Consult. This is useful as an independent reviewer even when the current host is
also Codex, because Consult runs it through the configured `codex` Profile.

Run the separate Codex Profile through the Codex Host Adapter in read-only mode
by default:

```sh
consult-codex delegate --agent codex --read-only -- "<prompt for Codex>"
```

Use background mode for longer reviews:

```sh
consult-codex delegate --agent codex --read-only --background -- "<prompt for Codex>"
consult-codex status <job-id> --wait
consult-codex result <job-id>
```

## Model And Effort

Default Codex model: leave `--model` unset so the configured Codex Profile uses
its default.

If the user asks for a specific Codex model or reasoning effort, preserve it:

```sh
consult-codex delegate --agent codex --read-only --model gpt-5.3-codex --effort high -- "<prompt for Codex>"
```

Useful variants are whatever the installed Codex Profile accepts. Do not invent
model names; if unsure, omit `--model` and let the Profile default apply.

## Prompt Shape

For code review, ask:

```text
Review the current changes for bugs, regressions, missing tests, and risky
assumptions. Prioritize actionable findings. Cite files/lines where possible.
If you find no issues, say that clearly and note any residual risk.
```

For design questions, ask Codex to challenge the implementation approach and
name simpler alternatives. For debugging questions, ask for ranked hypotheses
and focused checks.

## Rules

- Default to `--read-only`.
- Do not ask the delegated Codex to edit files unless the user explicitly asks
  for that.
- Do not use GitHub Copilot for this skill.
- Do not send secrets or PII in the prompt.
- Report useful findings back to the user, but keep the current Codex session
  responsible for deciding what to implement.
