# Consult

**Cross-agent delegation that returns the result, not the working context.**

Long implementation threads consume the same context your strongest model
needs for decomposition, review, and product decisions. Consult gives that
model a boundary: hand one cold, self-contained Job to another coding agent,
then bring back the answer, review, or patch artifact.

Codex, Claude Code, opencode, and a plain terminal can all use the same CLI.
Consult reuses the agent installations and authentication you already have,
while keeping each Job's read, write, and network authority explicit. No new
agent platform or second set of accounts.

## Try one Job

Install Consult, configure one Profile, and delegate from any Git repository:

```sh
$ npm install --global @aubwang/consult
$ consult setup --install claude
$ consult doctor --agent claude

$ consult delegate --agent claude --read-only --background \
  --label "retry inspection" -- \
  "Inspect the retry logic in scripts/. Return likely failure modes with file paths."
consult delegate job-a1b2 queued
consult status job-a1b2

$ consult wait --summary job-a1b2
job-a1b2 [retry inspection] completed | result: Found a cleanup race after cancellation.
```

The Profile starts cold. It receives the prompt, repository instructions, and
the Job Authority—not the Host's conversation. The bounded wait returns a result
preview while tool activity stays in the Job log; `consult result job-a1b2`
retrieves the full final answer when the Host needs it.

## Why Consult?

- **Keep working detail out of the Host context.** Profiles receive cold,
  self-contained prompts. The Host can collect bounded summaries, final
  answers, or patch artifacts without importing the delegate's tool transcript.
- **Cross agent boundaries without replacing your stack.** Invoke Claude from
  Codex, Codex from Claude Code, or either from opencode using the local agents
  and authentication you already configured.
- **Send authority with the Job.** Delegation defaults to read-only. Writes,
  transactional isolated worktrees, public-web research, and ambient authority
  inheritance are separate, explicit choices.
- **Review work without pulling it through the orchestrator.** One Profile can
  implement in a disposable worktree and another can review the resulting
  Consult-owned patch by Job id. The Host receives the review, not the diff.
- **Run orchestration as durable work.** Background Jobs have status, logs,
  results, cancellation, dependencies, and resume. Wait once for known work
  instead of spending model turns polling it.
- **Route by capability, speed, or cost when useful.** Keep the strongest model
  on the decisions that need it and hand well-scoped work to another Profile.

Consult is deliberately a CLI, not another agent platform. If your coding agent
can run a command, it can use Consult.

## How the boundary works

The invoking environment is the **Host**. A configured coding agent is a
**Profile**. Each delegation creates one durable **Job** for one prompt turn.
Built-in Claude and Codex Profiles support Consult-managed confinement;
opencode currently requires explicit `--sandbox inherit`.

```text
┌──────────────────────────────┐
│ Host context                 │
│ Decisions and decomposition  │
└──────────────┬───────────────┘
               │  cold prompt + Job Authority
        ┌──────┼──────┐
        ▼      ▼      ▼
     Claude  Codex  opencode
        │      │      │
        └──────┼──────┘
               │  result, review, or patch artifact
               ▼
┌──────────────────────────────┐
│ Host context                 │
│ Integration and decisions    │
└──────────────────────────────┘
```

Cold does not mean context-free: the Host is responsible for naming the
relevant paths, constraints, and acceptance checks. That prompt-writing cost is
the tradeoff for a deliberate context boundary. Consult provides bounded
inspection and artifact surfaces, but the Host must choose them; foreground
delegation deliberately streams progress.

## A delegated session

Suppose a Host is tracking down a flaky test. It can split investigation and
implementation without sharing its conversation with either Profile:

```sh
# A fast Profile traces the failure while another works on a fix.
$ consult delegate --agent claude --model haiku --read-only --background -- \
    "Trace the flaky cancellation tests. Return likely causes with file paths."
consult delegate job-a1b2 queued
consult status job-a1b2

$ consult delegate --agent codex --write --isolated --background -- \
    "Reproduce the cancellation race, add a regression test, and fix it."
consult delegate job-c3d4 queued
consult status job-c3d4

$ consult wait --summary job-a1b2 job-c3d4
job-a1b2 completed | result: Found a cleanup race after cancellation acknowledgement.
job-c3d4 completed | result: Added a regression test and fixed the cancellation race.

# Review the isolated patch without loading it into the Host context.
$ consult review --agent claude --job job-c3d4
No findings. The regression test exercises the cancellation boundary.
```

The Host remains the orchestrator: it decomposes the work, chooses each
Profile and Job Authority, then decides what to accept.

## Setup details

Consult requires Node.js 24 or newer. Native support covers Linux and Apple
Silicon macOS.

Global npm installs go under the active runtime's `npm prefix --global`.
If the machine has Homebrew, nvm, mise, or another Node manager, install and
update Consult through one chosen global prefix; otherwise multiple `consult`
executables can shadow one another on `PATH`. Use `type -a consult` and
`npm prefix --global` to diagnose this. See [Installation](docs/INSTALL.md) for
details.

```sh
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

The package exposes the four skill folders above. To make a selected skill
available across projects instead, add `--global`:

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

Or send a completed isolated implementation directly to another Profile for
review without loading its patch into the Host context:

```sh
consult review --agent codex --job <implementation-job-id>
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
consult wait --summary <job-id> [<job-id>...]
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
select an exact model or advertised family alias. Add `--label "<purpose>"` to
make durable Jobs easier to recognize later.

The [Usage reference](docs/USAGE.md) covers cold prompts, Profiles, authority,
isolated artifacts, background Jobs, resume, JSON output, and troubleshooting.

## Boundaries that travel with the task

Delegated work defaults to read-only, Consult-managed confinement for built-in
Claude and Codex Profiles on native Linux and Apple Silicon macOS. Writes and
public-web access are explicit grants. Consult never silently falls back to the
Host's ambient authority.

Confinement narrows filesystem and network access; it does not make untrusted
content harmless. opencode and custom Profiles currently require explicit
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
