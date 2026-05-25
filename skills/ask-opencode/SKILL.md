---
name: ask-opencode
description: Ask opencode through a Consult Profile for a second review, critique, explanation, debugging hypothesis, or design opinion while working in Codex. Use when the user says to consult opencode, ask opencode, get an opencode review, or use opencode as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should opencode answer or review?
---

# Ask opencode Through Consult

Use this skill when the user wants an opencode Profile second opinion through
Consult.

Run opencode through Consult in read-only mode by default:

```sh
consult delegate --agent opencode --read-only -- "<prompt for opencode>"
```

Use background mode for longer reviews:

```sh
consult delegate --agent opencode --read-only --background -- "<prompt for opencode>"
consult status <job-id> --wait
consult result <job-id>
```

## Model And Effort

Default opencode model: leave `--model` unset so the configured opencode Profile
uses its default.

If the user asks for a specific provider/model or effort, preserve it:

```sh
consult delegate --agent opencode --read-only --model openrouter/anthropic/claude-sonnet-4.5 --effort high -- "<prompt for opencode>"
```

Use model names accepted by the installed opencode Profile. Do not invent model
names; if unsure, omit `--model` and let the Profile default apply.

## Prompt Shape

For code review, ask:

```text
Review the current changes for bugs, regressions, missing tests, and risky
assumptions. Prioritize actionable findings. Cite files/lines where possible.
If you find no issues, say that clearly and note any residual risk.
```

For design questions, ask opencode to focus on maintainability and missed edge
cases. For debugging questions, ask for ranked hypotheses and minimal
reproduction ideas.

## Rules

- Default to `--read-only`.
- Do not ask opencode to edit files unless the user explicitly asks for that.
- Do not use GitHub Copilot for this skill.
- Do not send secrets or PII in the prompt.
- Report useful findings back to the user, but keep Codex responsible for
  deciding what to implement.
