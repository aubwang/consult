---
name: ask-claude
description: Ask the configured Claude Profile through Consult for an independent review, explanation, debugging hypothesis, or design opinion. Use when the user asks to consult Claude or get Claude's perspective.
---

# Ask Claude Through Consult

Give Claude one cold, self-contained prompt with the objective, exact Workspace
paths, constraints, expected answer, and evidence requested.

Default to confined read-only authority and Sonnet:

```sh
consult delegate --agent claude --read-only --model sonnet -- "<prompt>"
```

Use `consult review --agent claude [--base <ref>]` for the current Git change.
Use `consult review --agent claude --job <id>` to review a completed isolated
implementation Job without loading its patch into Host context.

For a longer second opinion, add `--background --label "<purpose>"`, then run
`consult wait <job-id>`. Preserve a user-requested model, effort, or authority.
Run `consult help --reference` instead of guessing unsupported model names.

Ask reviews for prioritized actionable findings with file and line evidence.
Ask debugging turns for ranked hypotheses and falsifying checks. Ask design
turns to separate concrete risks from optional suggestions.

- Keep the current Host responsible for conclusions and integration.
- Do not request edits unless the user requested implementation.
- Add `--allow-fetch` only when Claude itself needs public-web research.
- Never retry failed confinement with inheritance automatically.
- Never send secrets or PII.
