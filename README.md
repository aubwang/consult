<div align="center">

# Consult

**A cross-agent CLI your coding agent uses to delegate work. It gets back an answer, a review, or a patch — not the delegate's working context.**

Claude Code → Codex, Codex → Claude Code, opencode → either. Any direction, one CLI.

[![npm](https://img.shields.io/npm/v/%40aubwang%2Fconsult?color=cb3837&logo=npm)](https://www.npmjs.com/package/@aubwang/consult)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](docs/INSTALL.md)

[Install](#quick-start) · [Why](#why-consult) · [How it works](#how-it-works) · [Docs](docs/USAGE.md)

</div>

---

You already run more than one coding agent. Claude Code is great at one thing,
Codex at another, and your strongest model shouldn't burn its context window
babysitting a 40-minute implementation thread.

**Consult** is a small, host-neutral CLI that lets any coding environment — a
Claude Code session, a Codex session, opencode, or your own terminal — hand a
single, self-contained **Job** to another configured agent and get back a
result, a review, or a patch. It reuses the agent installations and
authentication you already have. No new platform, no second set of accounts,
no daemon.

```text
── your session · claude-fable-5 (primary agent) ──────────────────────

> our 429 retries hammer the API — add exponential backoff

⏺ I'll delegate the implementation to Codex in an isolated worktree and
  keep this session's context for review and integration.

⏺ Bash(consult delegate --agent codex --write --isolated --background --
      "Add exponential backoff with jitter to the 429 retry path.
       Include a regression test.")
  ⎿  consult delegate job-c3d4 queued

⏺ Bash(consult wait --summary job-c3d4)
  ⎿  job-c3d4 completed | result: Backoff with jitter added; regression
     test covers the 429 path.

⏺ Bash(consult review --agent claude --job job-c3d4)
  ⎿  No findings. The regression test exercises the retry boundary.

⏺ Codex's patch came back reviewed clean — applying it now. The diff
  never entered this conversation; only the result did.
```

## Why Consult?

**Context is the scarcest resource in agentic coding.** Every file an agent
reads, every test run, every dead end lands in its context window — the same
window it needs for decomposition, review, and judgment. Long implementation
threads make your best model dumber exactly when you need it sharpest.

Consult gives that model a boundary. The orchestrating agent (the **Host**)
writes one cold, self-contained prompt; a delegate agent (a **Profile**) does
the work in its own context; the Host gets back only what it asked for.

- 🧠 **Keep the working detail out of your context.** Delegates start cold and
  return bounded summaries, final answers, or patch artifacts — never their
  tool transcript.
- 🔀 **Cross agent boundaries without switching stacks.** Invoke Claude from
  Codex, Codex from Claude Code, or either from opencode — over the open
  [Agent Client Protocol](https://agentclientprotocol.com), using your
  existing local installs and logins.
- 🔒 **Authority travels with the Job, not the machine.** Delegation defaults
  to read-only, OS-level confinement. Writes, network access, and ambient
  authority inheritance are separate, explicit grants — never silent
  fallbacks.
- 🧪 **Transactional writes.** An implementation Job can run in a disposable
  Git worktree; Consult captures only its delta as a patch and touched-files
  manifest, and your checkout stays untouched until you decide to apply it.
- 📋 **Orchestration as durable work.** Background Jobs have status, logs,
  results, labels, cancellation, dependencies, and resume. Wait once for known
  work instead of spending model turns polling it.
- 💸 **Route by capability, speed, or cost.** Keep the expensive model on
  decisions and hand well-scoped work to a fast one — or fan a question out to
  three different agents and compare.

Consult is deliberately a CLI, not another agent platform. If your coding
agent can run a command, it can use Consult.

## How it works

The invoking environment is the **Host**. A configured agent is a **Profile**
(`claude`, `codex`, or `opencode` out of the box). Each delegation creates one
durable **Job** carrying exactly one prompt turn and one explicit **Job
Authority**.

```text
┌──────────────────────────────┐
│ Host context                 │
│ decisions · decomposition    │
└──────────────┬───────────────┘
               │  cold prompt + Job Authority
        ┌──────┼──────┐
        ▼      ▼      ▼
     Claude  Codex  opencode
        │      │      │
        └──────┼──────┘
               │  result · review · patch artifact
               ▼
┌──────────────────────────────┐
│ Host context                 │
│ integration · decisions      │
└──────────────────────────────┘
```

Cold doesn't mean context-free — the Host names the relevant paths,
constraints, and acceptance checks in the prompt. That small prompt-writing
cost is the price of a real context boundary, and it's the whole point.

## Quick start

Requires Node.js 24+ on Linux or Apple Silicon macOS
([details](docs/INSTALL.md)).

```sh
npm install --global @aubwang/consult

consult setup --install claude   # configure a Profile
consult doctor --agent claude    # verify it can delegate

consult delegate --agent claude --read-only -- \
  "Inspect the retry logic in scripts/. Report edge cases; do not edit."
```

That's a complete delegation: the Profile starts cold in your repository,
works inside a read-only confined boundary, and streams back its answer.

### A real session

From inside a session, delegation is just tool calls. The primary agent fans
a question out to two other models through their own agents, and neither
transcript ever lands in the main thread:

```text
── your session · claude-fable-5 (primary agent) ──────────────────────

> why do the cancellation tests only flake under load?

⏺ Two independent looks from two different models — while I keep working.

⏺ Bash(consult delegate --agent codex --model gpt-5.6-luna --read-only
      --background --label "trace flake" --
      "Trace the flaky cancellation tests under load. Return likely
       causes with file paths.")
  ⎿  consult delegate job-a1b2 queued

⏺ Bash(consult delegate --agent opencode --model glm-5.2 --sandbox inherit
      --background --label "pattern sweep" --
      "Find other unawaited-cleanup patterns in scripts/. Report file:line.")
  ⎿  consult delegate job-b2c3 queued

⏺ Bash(consult wait --summary job-a1b2 job-b2c3)
  ⎿  job-a1b2 [trace flake] completed | result: Cleanup race after the
     cancellation acknowledgement.
     job-b2c3 [pattern sweep] completed | result: Two more call sites
     share the same pattern.

⏺ Both models point at the cleanup race. I'll fix all three sites here
  and send the diff to a cold reviewer before committing.
```

Background Jobs compose: `--after <job-id>` chains a dependent prompt onto an
upstream result, `consult logs --follow` tails a running Job, `--json` makes
every result machine-readable, and `--resume` reopens a Profile session for a
follow-up turn. The [usage reference](docs/USAGE.md) covers all of it.

## Teach your agent to delegate

The CLI is self-describing (`consult help`), but the npm package also ships
agent **skills** that give a Host judgment about *when* to delegate, how to
write a cold prompt, and which authority to grant:

| Skill | Purpose |
| --- | --- |
| `consult` | General delegation workflow for any Host. |
| `ask-claude` | Ask Claude for a review, explanation, or second opinion. |
| `ask-codex` | Delegate focused work or review to Codex. |
| `ask-opencode` | Delegate through a configured opencode provider. |

```sh
npx skills add aubwang/consult
```

## Security posture

Delegating to an autonomous agent is running code. Consult treats that
seriously:

- New Jobs default to **read-only, OS-level confinement** with network fetch
  and command execution disabled (built-in Claude and Codex Profiles on Linux
  and Apple Silicon macOS).
- Every broader grant — writes, public-web research, ambient authority — is an
  **explicit flag on the Job**, and Consult never silently falls back to the
  Host's ambient authority when confinement fails.
- Isolated write Jobs are **transactional**: the delegate edits a disposable
  worktree, and only a reviewable patch comes back.

Confinement narrows what a delegate can touch; it doesn't make untrusted
content harmless. The full boundary model is documented in
[Job Authority](docs/USAGE.md#job-authority), and the tested platform matrix
lives in the [conformance reports](docs/conformance/README.md).

## Learn more

| | |
| --- | --- |
| [Installation](docs/INSTALL.md) | Prerequisites, npm-prefix gotchas, verification. |
| [Usage reference](docs/USAGE.md) | Cold prompts, Profiles, authority, artifacts, background Jobs, JSON output. |
| [Domain glossary](CONTEXT.md) | The Host / Profile / Job / Broker language, precisely defined. |
| [Architecture notes](docs/PLAN.md) | How Consult is built. |
| [Roadmap](docs/ROADMAP.md) | Where it's going. |
| [ADRs](docs/adr/) | Accepted architecture decisions. |

## License

[Apache License 2.0](LICENSE)
