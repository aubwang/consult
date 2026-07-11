---
name: ask-opencode
description: Ask the configured opencode Profile through Consult for an independent review, explanation, debugging hypothesis, or design opinion. Use when the user asks to consult opencode or get an opencode perspective.
---

# Ask opencode Through Consult

Give opencode one cold, self-contained prompt with the objective, exact
Workspace paths, constraints, expected answer, and evidence requested.

opencode currently requires the trusted Host's inherited sandbox:

```sh
consult delegate --agent opencode --read-only --sandbox inherit -- "<prompt>"
```

For a longer second opinion, add `--background --label "<purpose>"`, then run
`consult wait <job-id>`. Preserve a user-requested provider/model or effort.
Otherwise leave `--model` unset to use opencode's configured default; use
`consult help --reference` rather than guessing model names.

Ask reviews for prioritized actionable findings with file and line evidence.
Ask debugging turns for ranked hypotheses and minimal reproduction ideas. Ask
design turns to focus on maintainability and missed edge cases.

- Keep the current Host responsible for conclusions and integration.
- Do not request edits unless the user requested implementation.
- State the inherited-authority limitation when it materially affects the task.
- Do not add `--allow-fetch`; fetch requires confinement.
- Delegate only to opencode rather than silently substituting another Profile.
- Never send secrets or PII.
