---
name: consult
description: Delegate work to configured Claude, Codex, or opencode Profiles through Consult. Use for focused second opinions, model routing, parallel tasks, delegated implementation, predictable Job pipelines, or operating Consult Jobs.
---

# Consult Delegation

Keep the Host responsible for orchestration and integration. Give each Profile
one cold, self-contained Job.

## Shape the Job

Delegate a bounded task when independent work, a different perspective, or a
cheaper model justifies the handoff. Keep judgment-heavy task decomposition in
the Host.

Build the prompt from:

1. objective and acceptance criteria;
2. exact Workspace paths and relevant interfaces;
3. constraints and granted authority;
4. expected deliverable and verification evidence.

Point to Workspace files instead of pasting their contents. Confined delegates
cannot read Host-private attachment or cache paths outside the Workspace; read
those in the Host and embed only the bounded content the delegate needs. Use
`--include-diff` or `consult review` for a pinned Git change.

Route models by task shape:

- complete mechanical specification, usually 1–2 files: faster/cheaper model;
- integration, debugging, or multi-file coordination: standard model;
- architecture, subtle risk, or final review: strongest suitable model.

Optimize for total turns, not token price alone. Omit `--model` when the
configured Profile default is intentional; otherwise pass it explicitly.

## Choose Authority

- Default investigations and reviews to `--read-only` confinement.
- Use `--write --isolated` for implementation so the Host receives a patch
  without changing its checkout.
- Add `--allow-fetch` only when the Profile needs public-web research; readable
  Job data can then be sent to public hosts.
- Use `--sandbox inherit` only when the trusted Host deliberately accepts its
  ambient boundary. Custom and opencode Profiles currently require it.
- Never weaken authority automatically after preflight failure.

## Run and Collect

Use foreground delegation for one quick answer:

```sh
consult delegate --agent <profile> --read-only -- "<cold prompt>"
```

Use a label and background Job for durable or parallel work:

```sh
consult delegate --agent <profile> --read-only --background \
  --label "dependency audit" -- "<cold prompt>"
consult wait <job-id>
```

Use `consult wait --summary <job-id>...` when the Host needs completion and
artifact locations without loading every full result. Retrieve a selected full
answer with `consult result <job-id>`.

For substantial implementation Jobs, request this semantic report contract:

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Summary: <what changed or what prevented progress>
Evidence: <tests or checks actually run>
Concerns: <remaining uncertainty, or none>
```

These values are Profile claims, not Consult transport states. A Job marked
`completed` only proves the Profile turn ended; inspect its report and verify
important evidence.

Review a completed isolated implementation without loading its patch into Host
context:

```sh
consult review --agent <review-profile> --job <implementation-job-id> \
  --label "implementation review"
```

The reviewer receives the source task, report, touched files, and Consult-owned
patch as pinned untrusted data.

Use `--after <job-id>` only when the downstream prompt, Profile, model, and
authority are known before seeing the upstream answer. Otherwise wait, inspect,
and let the Host decide. Failed, cancelled, or skipped prerequisites skip the
dependent Job without a model call.

Prefer one blocking `wait` over polling. For a nonblocking check, use
`consult status <job-id>` once. Read progress only when necessary with a small
window such as `consult logs <job-id> --tail 10`.

## Reference and Guardrails

Run `consult help` for commands, `consult help --reference` for exact contracts,
and `consult doctor --agent <profile>` for readiness. Do not inspect private Job
or Broker files directly.

- Never include secrets or PII in prompts.
- Do not use `--allow-exec`; it is unavailable.
- Keep concurrency bounded; Consult has no CPU, memory, disk, process-count, or
  global fan-out quota.
- Report unavailable Profiles or failed Doctor results instead of silently
  substituting another agent.
