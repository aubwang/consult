# Consult

**One CLI for your coding agent to delegate to other coding agents.**

Consult lets Codex, Claude Code, opencode, or a terminal call in the right
subagent for a task. It uses the agent installations and authentication you
already have—no Consult plugin, second agent stack, or new set of accounts.

In concrete terms: **while you are working inside Codex, Claude Code, or opencode, your current agent can invoke any of the others as a subagent and use the result in the same session.** The spawning agent stays in charge while Consult runs the selected agent behind one common CLI.

```text
┌──────────────────────────────┐
│ Your Host agent              │
│ Codex                        │
└──────────────┬───────────────┘
               │
          consult delegate
               │
               ├──▶ Claude Code · Haiku
               │    Fast research
               │
               ├──▶ Codex · GPT
               │    Focused implementation
               │
               └──▶ opencode · Grok
                    Independent second opinion
```

Keep a strong model in the driver's seat while cheaper or faster models handle
focused work. Run specialists in parallel, bring in a different agent when you
want another perspective, and keep control of what each one can read, change,
or fetch.

## Why Consult?

- **Use any configured agent from any Host.** The same command works from
  Codex, Claude Code, opencode, and an ordinary shell.
- **Route work instead of paying one model to do everything.** Send routine
  investigation to a fast model and save heavyweight models for the decisions
  that need them.
- **Get a genuinely different second opinion.** Ask Claude to review Codex's
  patch, or have Codex challenge an opencode investigation.
- **Keep the spawning agent in control.** Delegates default to read-only. The
  Host can opt into isolated writes, public-web research, background work,
  cancellation, or resume.
- **Know what happened.** Each delegated turn has a durable status, log, result,
  and—when it writes—an optional patch artifact.
- **Chain predictable work without babysitting it.** Let cheap research Jobs
  feed a later synthesis Job, then wait once for the finished pipeline.

Consult is deliberately a CLI, not another agent platform. If your coding agent
can run a command, it can use Consult.

## A delegated session

Suppose a Host agent is tracking down a flaky test. It can split the work
without sharing its entire conversation with every subagent:

```sh
# A fast model traces the failure while another agent works on a fix.
$ consult delegate --agent claude --model haiku --read-only --background -- \
    "Trace the flaky cancellation tests. Return likely causes with file paths."
consult delegate job-a1b2 queued

$ consult delegate --agent codex --model gpt-5.4-mini \
    --write --isolated --background -- \
    "Reproduce the cancellation race, add a regression test, and fix it."
consult delegate job-c3d4 queued

$ consult wait job-a1b2 job-c3d4
job-a1b2 completed
Found a cleanup race after cancellation acknowledgement.

job-c3d4 completed
Added a regression test and fixed the cancellation cleanup race.

# Before accepting the patch, call in a heavyweight second opinion.
$ consult delegate --agent claude --model opus --read-only --include-diff -- \
    "Review this fix. Look for lifecycle gaps and tests that can pass falsely."
```

The Host remains the orchestrator. Each subagent receives one cold,
self-contained prompt, does its part, and returns a result the Host can inspect
or combine with the others.

## Get started

Consult requires Node.js 24 or newer, and is supported on Linux and Apple Silicon (M-Series) macOS devices

```sh
npm install --global @aubwang/consult

consult setup
consult setup --install claude
consult setup --install codex
consult agents
```

Profile IDs are `claude`, `codex`, and `opencode`. Consult discovers their
supported local installations and keeps its Profile configuration under
`~/.consult`.

Run Doctor before the first delegation:

```sh
consult doctor --agent claude
consult doctor --agent codex
```

You are ready when Doctor reports that the selected Profile can delegate. For
Linux prerequisites, Apple Silicon notes, and development-checkout setup, see
[Installation](docs/INSTALL.md).

## Teach your Host about Consult

The CLI works without a skill: an agent can always run `consult help` and invoke
the commands directly. Skills make Consult easier for a Host to discover and
use well. They provide judgment about when to delegate, how to write a cold
prompt, and which authority to grant. `consult help` is the quick command
overview; `consult help --reference` is the detailed contract for exact flags
and behavior.

The npm package includes these user-facing skill folders:

| Skill | Purpose |
| --- | --- |
| `consult` | General delegation workflow for any Host. |
| `ask-claude` | Ask Claude for a review, explanation, or second opinion. |
| `ask-codex` | Delegate focused work or review to Codex. |
| `ask-opencode` | Delegate through a configured opencode provider. |

Install them for the current project with the standard Skills CLI:

```sh
npx skills add aubwang/consult
```

The installer asks which Consult skill and detected coding agent to use. To
make your selection available across projects instead, add `--global`:

```sh
npx skills add aubwang/consult --global
```

Skill installation is optional and separate from installing the Consult CLI.
The repository checkout also exposes the generic skill to opencode through
`.opencode/skills/consult`. See the
[Usage reference](docs/USAGE.md#optional-agent-skills) for manual installation
and scope details.

## Common tasks

Read-only inspection is the default:

```sh
consult delegate --agent claude -- \
  "Inspect the retry logic in scripts/. Report edge cases; do not edit."
```

Let an implementation agent work in a disposable worktree and return its patch:

```sh
consult delegate --agent codex --write --isolated -- \
  "Add regression coverage for the timeout path and implement the fix."
```

Review a pinned diff through any configured Profile:

```sh
consult review --agent claude --base main
```

Grant public-web access when research is part of the delegated task:

```sh
consult delegate --agent claude --allow-fetch -- \
  "Check the current upstream documentation for this API and cite the change."
```

Background Jobs can be inspected and controlled without keeping a terminal
attached:

```sh
consult wait <job-id> [<job-id>...]
consult logs <job-id> --follow
consult result <job-id>
consult cancel <job-id>
consult delegate --agent claude --resume -- "Now check the remaining edge case."
```

When a downstream prompt is known before an upstream answer arrives, declare a
dependency and let Consult pass the bounded result forward:

```sh
consult delegate --agent claude --model haiku --allow-fetch --background -- \
  "Find the teams still playing in the tournament. Return evidence."
# Suppose that prints job-research.

consult delegate --agent codex --background --after job-research -- \
  "Compare the remaining teams using the upstream research."

consult wait job-research <dependent-job-id>
```

If the next prompt, authority, or model depends on the quality of the upstream
answer, wait and inspect it first instead of using `--after`. Interrupting
`consult wait` normally cancels its still-active Jobs; add `--keep-running` when
they should remain detached.

Use `--json` when another agent or script will parse the result. Use
`--include-diff` for a stable snapshot of uncommitted changes, and `--model` to
select an exact model or advertised family alias.

The [Usage reference](docs/USAGE.md) covers cold prompts, Profiles, authority,
isolated artifacts, background Jobs, resume, JSON output, and troubleshooting.

## Boundaries that travel with the task

Delegated work defaults to read-only, Consult-managed confinement for built-in
Claude and Codex Profiles on native Linux and Apple Silicon macOS. Writes and
public-web access are explicit grants. Consult never silently falls back to the
Host's ambient authority.

Confinement narrows filesystem and network access; it does not make untrusted
content harmless. OpenCode and custom Profiles currently require explicit
inheritance, and native Windows and Intel macOS are unsupported. See
[Job Authority](docs/USAGE.md#job-authority) for the full boundary and the
[conformance reports](docs/conformance/README.md) for the tested matrix.

## Learn more

- [Installation](docs/INSTALL.md)
- [Usage reference](docs/USAGE.md)
- [Architecture and implementation notes](docs/PLAN.md)
- [Roadmap](docs/ROADMAP.md)
- [Conformance reports](docs/conformance/README.md)
- [Accepted architecture decisions](docs/adr/)

## License

Consult is available under the [Apache License 2.0](LICENSE).
