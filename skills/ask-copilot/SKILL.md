---
name: ask-copilot
description: Ask GitHub Copilot through a Consult Profile for a second review, critique, explanation, debugging hypothesis, or design opinion from the current Host. Use when the user says to consult Copilot, ask Copilot, get a Copilot review, or use Copilot as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should Copilot answer or review?
---

# Ask Copilot Through Consult

Use this skill when the user wants a GitHub Copilot Profile second opinion
through Consult.

Run Copilot through Consult in read-only mode by default:

```sh
consult delegate --agent copilot --read-only -- "<prompt for Copilot>"
```

Use background mode for longer reviews:

```sh
consult delegate --agent copilot --read-only --background -- "<prompt for Copilot>"
consult status <job-id> --wait
consult result <job-id>
```

## Model And Effort

Default Copilot model: leave `--model` unset so the configured Copilot Profile
uses its default.

If the user asks for a specific Copilot model or reasoning effort, preserve it:

```sh
consult delegate --agent copilot --read-only --model <copilot-model> --effort high -- "<prompt for Copilot>"
```

Use model names accepted by the installed Copilot CLI. Do not invent model
names; if unsure, omit `--model` and let the Profile default apply.

## Prompt Shape

For code review, ask:

```text
Review the current changes for bugs, regressions, missing tests, and risky
assumptions. Prioritize actionable findings. Cite files/lines where possible.
If you find no issues, say that clearly and note any residual risk.
```

For design questions, ask Copilot to focus on maintainability and missed edge
cases. For debugging questions, ask for ranked hypotheses and minimal
reproduction ideas.

## Rules

- Default to `--read-only`.
- Do not ask Copilot to edit files unless the user explicitly asks for
  that.
- Delegate to the `copilot` Profile only; do not substitute a different
  Profile.
- Do not send secrets or PII in the prompt.
- Report useful findings back to the user, but keep the current Host
  responsible for deciding what to implement.
