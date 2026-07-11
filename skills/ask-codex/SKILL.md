---
name: ask-codex
description: Ask a separate configured Codex Profile through Consult for an independent review, explanation, debugging hypothesis, or design opinion. Use when the user asks to consult another Codex or get a Codex perspective.
---

# Ask Codex Through Consult

Give the separate Codex Profile one cold, self-contained prompt with the
objective, exact Workspace paths, constraints, expected answer, and evidence
requested.

Default to confined read-only authority:

```sh
consult delegate --agent codex --read-only -- "<prompt>"
```

Use `consult review --agent codex [--base <ref>]` for the current Git change.
Use `consult review --agent codex --job <id>` to review a completed isolated
implementation Job without loading its patch into Host context.

For a longer second opinion, add `--background --label "<purpose>"`, then run
`consult wait <job-id>`. Preserve a user-requested model, effort, or authority.
Host `config.toml` is not copied into confinement, so pass `--model` when it
controls the intended choice. Use `consult help --reference` rather than
guessing model names.

Ask reviews for prioritized actionable findings with file and line evidence.
Ask debugging turns for ranked hypotheses and focused checks. Ask design turns
to challenge the approach and identify simpler alternatives.

- Keep the current Host responsible for conclusions and integration.
- Do not request edits unless the user requested implementation.
- Add `--allow-fetch` only when Codex itself needs public-web research.
- Never retry failed confinement with inheritance automatically.
- Never send secrets or PII.
