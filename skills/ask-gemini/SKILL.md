---
name: ask-gemini
description: Ask Google Gemini CLI through a Consult Profile for a second review, critique, explanation, debugging hypothesis, or design opinion from the current Host. Use when the user says to consult Gemini, ask Gemini, get a Gemini review, or use Gemini as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should Gemini answer or review?
---

# Ask Gemini Through Consult

Use this skill when the user wants a Gemini CLI Profile second opinion through
Consult.

Run Gemini through Consult in read-only mode by default:

```sh
consult delegate --agent gemini --read-only -- "<prompt for Gemini>"
```

Use background mode for longer reviews:

```sh
consult delegate --agent gemini --read-only --background -- "<prompt for Gemini>"
consult status <job-id> --wait
consult result <job-id>
```

## Model And Effort

Default Gemini model: leave `--model` unset so the configured Gemini CLI Profile
uses its default.

If the user asks for a specific Gemini model or reasoning effort, preserve it:

```sh
consult delegate --agent gemini --read-only --model <gemini-model> --effort high -- "<prompt for Gemini>"
```

Use model names accepted by the installed Gemini CLI. Do not invent model names;
if unsure, omit `--model` and let the Profile default apply.

## Prompt Shape

For code review, ask:

```text
Review the current changes for bugs, regressions, missing tests, and risky
assumptions. Prioritize actionable findings. Cite files/lines where possible.
If you find no issues, say that clearly and note any residual risk.
```

For design questions, ask Gemini to focus on missed alternatives and integration
risks. For debugging questions, ask for ranked hypotheses and minimal
reproduction ideas.

## Rules

- Default to `--read-only`.
- Do not ask Gemini to edit files unless the user explicitly asks for
  that.
- Delegate to the `gemini` Profile only; do not substitute a different
  Profile.
- Do not send secrets or PII in the prompt.
- Report useful findings back to the user, but keep the current Host
  responsible for deciding what to implement.
