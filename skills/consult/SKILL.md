---
name: consult
description: Delegate focused work from the current coding-agent Host to a configured Claude, Codex, or opencode subagent through the Consult CLI. Use when the user wants another agent or model, a second opinion, parallel investigation, delegated implementation, or help operating Consult Jobs.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult Delegation

Use `consult` to call another coding agent without leaving the current Host
conversation. The Host remains responsible for orchestration and integration;
the delegated Profile receives one cold, self-contained prompt and returns a
Job result.

## Decide whether to delegate

Delegate when at least one is true:

- a bounded subtask can run independently;
- a faster or cheaper model can handle focused work;
- a different agent or heavyweight model would provide a useful second opinion;
- parallel investigation will shorten the critical path.

Keep the work in the current Host when delegation overhead exceeds the task or
the task depends on conversational context that cannot be packaged clearly.

## Shape the Job

1. Choose the Profile and model that fit the task.
2. Write a cold prompt containing:
   - the concrete objective;
   - relevant files, facts, or attached diff;
   - constraints and permitted scope;
   - the expected deliverable;
   - verification or evidence required.
3. Do not refer to unstated Host context with phrases such as “as discussed” or
   “continue what we were doing.”

Use `--include-diff` or `consult review` when the delegate needs a stable view of
the current Git change.

## Choose authority deliberately

- Default to read-only confinement for investigation, explanation, and review.
- When edits are explicitly requested, prefer `--write --isolated` so the Host
  receives a patch without changing its checkout.
- Add `--allow-fetch` only when the subagent itself needs public-web research;
  readable Job data can then be sent to public hosts.
- Use `--sandbox inherit` only when the trusted Host deliberately accepts its
  ambient boundary. Never retry with inheritance automatically after confined
  preflight fails. Custom and opencode Profiles currently require inheritance.
- Do not grant authority the user did not request.

## Run and collect

Use the foreground path for one quick dependency:

```sh
consult delegate --agent <profile> --read-only -- "<self-contained prompt>"
```

Use background Jobs for parallel or longer work, then collect each result:

```sh
consult delegate --agent <profile> --read-only --background -- "<prompt>"
consult status <job-id> --wait
consult result <job-id>
```

Treat delegate prose as a claim, not proof. Check Job status and artifacts, and
verify important edits or test results before integrating them.

## Use the CLI as the reference

Run `consult help` for a quick command overview. Run
`consult help --reference` before using unfamiliar flags or relying on exact
authority, model, JSON, resume, or exit-code behavior. Run
`consult doctor --agent <profile>` when setup, authentication, confinement, or
the current Host context may be the problem.

Do not inspect Consult's private Job files or Broker internals. Use `status`,
`logs`, `result`, `chain`, `cancel`, `agents`, `setup`, `doctor`, and `brokers`
through the CLI.

## Guardrails

- Do not include secrets or PII in delegated prompts.
- Do not use `--allow-exec`; it is currently unavailable.
- Keep concurrent delegation bounded; Job time and log limits are not CPU,
  memory, disk, process-count, or global fan-out quotas.
- If Consult is unavailable or a Profile is not ready, report the failed setup
  or Doctor result instead of silently substituting another agent or weakening
  authority.
