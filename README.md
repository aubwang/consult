<div align="center">

# Consult

**A cross-agent CLI your coding agent uses to delegate work and preserve context.**

Claude Code ↔️ Codex

Opencode ↔️ either

[![npm](https://img.shields.io/npm/v/%40aubwang%2Fconsult?color=cb3837&logo=npm)](https://www.npmjs.com/package/@aubwang/consult)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?logo=node.js&logoColor=white)](docs/INSTALL.md)

[Install](#quick-start) · [Why](#why-consult) · [How it works](#how-it-works) · [Docs](docs/USAGE.md)



</div>

Let your largest, most expensive model focus its effort and context on design, have a separate
model focus on implementation, and have another model provide a different opinion, all within
the same agent thread.

Why should Claude Fable (or some other giant model) burn context and money writing 
basic code and running tests? 

**Consult** is a small, host-neutral CLI that lets a coding environment — a
Claude Code session, a Codex session, opencode, or your own terminal — hand a
self-contained **Job** to another configured agent and get back a
result, a review, or a patch. It uses the [Agent Client Protocol](https://agentclientprotocol.com)
to hook into your existing Claude/Codex/opencode/Copilot install and auth.


<div align="center">
<img width="588" height="265" alt="image" src="https://github.com/user-attachments/assets/45bb8340-471b-40e7-985a-6e771e945b02" />
</div>

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
window it needs for decomposition, review, and judgment. Why not save your 
context and tokens for the important stuff instead?

With Consult, the orchestrating agent (the **Host**)
writes one cold, self-contained prompt; a delegate agent (a **Profile**) does
the work in its own context; the Host gets back only what it asked for.

- 🧠 **Keep working detail out of your context.** Delegates start cold and
  return bounded summaries, final answers, or patch artifacts — never their
  tool transcript. The boundary is opt-in depth; every Job
  keeps its full activity log on disk and is a single command away when
  something deserves a closer look.
- 🔀 **Cross agent boundaries without switching stacks.** Invoke Claude from
  Codex, Codex from Claude Code, or either from opencode, and vice versa --
  using your existing local installs and logins.
- 🔒 **Job level authority controls.** Delegation defaults
  to read-only, OS-level confinement. Writes, network access, and ambient
  authority inheritance are separate, explicit grants.
- 🧪 **Transactional writes.** An implementation Job can run in a disposable
  Git worktree; Consult captures only its delta as a patch and touched-files
  manifest, and your checkout stays untouched until you decide to apply it.
- 📋 **Orchestration as durable work.** Jobs have status, logs,
  results, labels, cancellation, dependencies, and resume. Wait once for known
  work instead of spending model turns polling it.
- 💸 **Route by capability, speed, or cost.** Keep the expensive model on
  decisions and hand well-scoped work to a fast one, or fan a question out to
  three different agents and compare.

Consult is deliberately a CLI, not another agent platform. If your coding
agent can run a command, it can use Consult.


## Quick start

Requires Node.js 22.18+ on Linux or Apple Silicon macOS
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
upstream result, `consult logs --follow` tails a running Job, `consult events`
reads the interim events a Job wrote with `consult report`, `consult steer`
sends guidance back into a Job that is still running, `--json` makes every
result machine-readable, and `--resume` reopens a Profile session for a
follow-up turn. A Host that needs to know which of these the installed build has
asks `consult capabilities --json` instead of guessing. The
[usage reference](docs/USAGE.md) covers all of it.

### Teach your agent to delegate

There is no skill to install, no plugin, no MCP server. `consult help` carries
the judgment itself — *when* delegating is worth it, how to write a prompt that
survives having no conversation behind it, which authority to grant — and
discloses it progressively, so an agent reads one screenful and then only the
topic it needs:

```sh
consult help              # commands, topics, and where to start
consult help delegation   # when to hand work off, and how to shape the prompt
consult help authority    # read-only, write, isolated, fetch, sandbox modes
consult help profiles     # Claude, Codex, opencode, Copilot: models, auth
consult help review       # pinned reviews and resolving findings out of context
consult help <command>    # the flags for one command
consult help --all        # every topic at once, for preloading a context
```

Point your agent at it once, in whatever instruction file it already reads
(`AGENTS.md`, `CLAUDE.md`, a system prompt):

> For second opinions, delegated implementation, or cold review, use Consult.
> Run `consult help` first.

Because the help ships inside the binary, an agent's advice can never drift
from the CLI it is running.

### Reviewed, not derailed

Delegating a review is cheap, but cleanup can eat all of your thread's context too.

`consult help review` describes a **resolution manager** loop: hand the findings
to a separate context that triages every claim, lands and verifies the clear-cut
fixes, and sends back a report with what was fixed, what was rejected, what needs
additional input, and whether any fix affects downstream work.

This way, your main model can keep making progress, and minor bugs/edge cases don't slow you down.



## How it works

The invoking environment is the **Host**. A configured agent is a **Profile**
(`claude`, `codex`, `opencode`, or `copilot` out of the box). Each delegation
creates one durable **Job** carrying exactly one prompt turn and one explicit
**Job Authority**.

```text
┌──────────────────────────────────┐
│ Host context                     │
│ decisions · decomposition        │
└────────────────┬─────────────────┘
                 │  cold prompt + Job Authority
        ┌────────┼────┬───────┐
        ▼        ▼    ▼       ▼
     Claude  Codex  opencode  Copilot
        │        │    │       │
        └────────┼────┴───────┘
                 │  result · review · patch artifact
                 ▼
┌──────────────────────────────────┐
│ Host context                     │
│ integration · decisions          │
└──────────────────────────────────┘
```
Please note that Job Authority behavior will vary depending on if you use Claude, Codex, opencode, or Copilot, see below.

## Security

**It's recommended to run Consult within an isolated VM/sandbox, or 
anywhere where you'd be comfortable running an agent in YOLO mode.
There are no guarantees that all risk has been abated. Use Consult
at your own risk.**

The full boundary model is documented in
[Job Authority](docs/USAGE.md#job-authority), and the tested platform matrix
lives in the [conformance reports](docs/conformance/README.md).

A delegated Job is a real agent working against your repository, so the
defaults stay conservative:

- New Jobs default to **read-only, OS-level confinement** with network fetch
  and command execution disabled (built-in Claude and Codex Profiles on Linux
  and Apple Silicon macOS). The opencode and Copilot Profiles have no
  confinement support yet and require an explicit `--sandbox inherit` grant.
- Every broader grant — writes, public-web research, ambient authority — is an
  **explicit flag on the Job**, and Consult never silently falls back to the
  Host's ambient authority when confinement fails.
- Isolated write Jobs are **transactional**: the delegate edits a disposable
  worktree, and only a reviewable patch comes back.

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
