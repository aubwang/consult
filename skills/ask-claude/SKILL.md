---
name: ask-claude
description: Ask Claude Code through Consult for a second review, critique, explanation, debugging hypothesis, or design opinion while working in Codex. Use when the user says to consult Claude, ask Claude, get Claude's opinion, get a Claude review, or use Claude as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should Claude answer or review?
---

# Ask Claude Through Consult

Use this skill when the user wants Codex to ask Claude Code for an independent
second opinion while staying inside the current Codex conversation.

Run Claude through Consult in read-only mode by default:

```sh
consult delegate --agent claude --read-only --model sonnet -- "<prompt for Claude>"
```

Use background mode for longer reviews:

```sh
consult delegate --agent claude --read-only --model sonnet --background -- "<prompt for Claude>"
consult status <job-id> --wait
consult result <job-id>
```

## Model And Effort

Default Claude model: `--model sonnet`.

If the user asks for a specific Claude variant, preserve it:

```sh
consult delegate --agent claude --read-only --model opus -- "<prompt for Claude>"
```

If the user asks for effort or another Consult option, pass it through:

```sh
consult delegate --agent claude --read-only --model sonnet --effort high -- "<prompt for Claude>"
```

User-supplied `--model` and `--effort` override the examples above.

## Prompt Shape

For code review, ask:

```text
Review the current changes for bugs, regressions, missing tests, and risky
assumptions. Prioritize actionable findings. Cite files/lines where possible.
If you find no issues, say that clearly and note any residual risk.
```

For design questions, ask Claude to separate concrete risks from suggestions.
For debugging questions, ask Claude for ranked hypotheses and what evidence
would confirm or falsify each one.

## Rules

- Default to `--read-only`.
- Do not ask Claude to edit files unless the user explicitly asks for that.
- Do not use GitHub Copilot for this skill.
- Do not send secrets or PII in the prompt.
- Report Claude's useful findings back to the user, but keep Codex responsible
  for deciding what to implement.
