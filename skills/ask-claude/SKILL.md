---
name: ask-claude
description: Ask the Claude Profile through Consult for a second review, critique, explanation, debugging hypothesis, or design opinion from the current Host. Use when the user says to consult Claude, ask Claude, get Claude's opinion, get a Claude review, or use Claude as a supporter.
metadata:
  "consult.disable-model-invocation": "true"
  "consult.argument-hint": What should Claude answer or review?
---

# Ask Claude Through Consult

Use this skill when the user wants the current Host to ask the Claude Profile for an
independent second opinion while staying inside the current Host conversation.

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

Default Claude model: `--model sonnet`, which Consult expands to the newest
available Sonnet model.

If the user asks for a specific Claude variant, preserve it:

```sh
consult delegate --agent claude --read-only --model opus -- "<prompt for Claude>"
```

Family aliases (`sonnet`, `opus`, `haiku`, `fable`) resolve dynamically to the
newest matching model the agent advertises. When the agent does not advertise
its model list, Consult falls back to static ids: `sonnet` expands to
`claude-sonnet-5`, `opus` to `claude-opus-4-8`, `haiku` to `claude-haiku-4-5`,
and `fable` to `claude-fable-5`. Explicit model ids are passed through
unchanged.

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

Prefer `consult review --agent claude [--base <ref>]` when the request is
specifically about the current Git change; it pins the diff before delegation.

For design questions, ask Claude to separate concrete risks from suggestions.
For debugging questions, ask Claude for ranked hypotheses and what evidence
would confirm or falsify each one.

## Rules

- Default to `--read-only`.
- Do not ask Claude to edit files unless the user explicitly asks for
  that.
- Delegate to the `claude` Profile only; do not substitute a different
  Profile.
- Do not send secrets or PII in the prompt.
- Report useful findings back to the user, but keep the current Host
  responsible for deciding what to implement.
