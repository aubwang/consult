# Consult

[![npm](https://img.shields.io/npm/v/%40aubwang%2Fconsult?color=cb3837&logo=npm)](https://www.npmjs.com/package/@aubwang/consult)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Consult lets your coding agent hand work to another coding agent and get back just the result.

When an agent investigates something itself, every file it opens and every command it runs lands in its context and stays there. With Consult, it can run `consult delegate` instead. A second agent takes a self-contained task, works through it in a fresh context, and returns a report, or a patch if the task was a code change. Your session gets the answer without the twenty files behind it, and keeps its context for planning and review. The work isn't hidden from you: you can read the second agent's log, or reopen its conversation and ask a follow-up.

The second agent doesn't have to match the first. Codex can ask Claude for a second opinion, Claude Code can hand an implementation to Codex, and routine work can go to a cheaper model. Through opencode you can reach other providers too. Consult talks to each agent over the [Agent Client Protocol](https://agentclientprotocol.com) and uses the logins you already have.

Delegated agents start read-only. Claude and Codex run inside an OS sandbox, and code changes can come back as a patch for you to review before anything touches your checkout.

## What it looks like

```sh
# Ask a question. Claude can read the repository but not change it.
consult delegate --agent claude -- \
  "Why does test/queue.test.ts fail intermittently? Find the root cause and cite file:line evidence."

# Hand off a change. Codex works in a separate worktree and returns a patch.
consult delegate --agent codex --write --isolated --background -- \
  "Add jitter to the retry backoff in src/queue/retry.ts, with a regression test. Report the files you changed and anything you couldn't verify."

# Keep working. Later, collect the result and have Claude review the patch.
consult wait --summary <job-id>
consult review --agent claude --job <job-id>
```

The first command streams Claude's progress and ends with its answer. The second prints a job id and returns right away. Your checkout doesn't change until you apply the patch.

You won't usually type these yourself. Once your agent [knows about Consult](#teach-your-agent-to-use-it), you ask for a review or a handoff in plain words and it runs the commands.

## Install

```sh
npm install --global @aubwang/consult
consult setup --install claude     # or codex, opencode, pi, copilot
consult doctor --agent claude
```

Log in to the agent itself first (for example `codex login`, or `/login` inside `claude`). `setup --install` installs the agent or its ACP adapter and registers it with Consult. `doctor` launches it the way a real job would, without sending a prompt, and tells you what's wrong if that fails. Run `doctor` from wherever you'll delegate, because your agent's own sandbox can change the result.

You'll need:

- Node.js 22.18 or newer
- Linux (WSL2 works) or an Apple Silicon Mac; native Windows isn't supported
- `bubblewrap`, `socat`, and `ripgrep` on Linux, for the sandbox
- a Git repository to work in

The [install guide](docs/INSTALL.md) covers Ubuntu's user-namespace restrictions, macOS credentials, and duplicate installs across Node version managers.

## Teach your agent to use it

There's no plugin, skill, or MCP server to install. Add a line like this to the instructions your agent already reads (`AGENTS.md`, `CLAUDE.md`, or a system prompt):

> For second opinions, delegated implementation, or cold review, use Consult. Run `consult help` first.

`consult help` fits on one screen and points to topics the agent can read when it needs them. `consult help delegation` covers when a handoff is worth it and how to write a prompt that stands on its own; `consult help workflows` covers worker, test, and reviewer loops. The guidance ships inside the binary, so it always matches the version you have installed. Most commands also take `--json`, and `consult capabilities --configured --json` tells an agent which agents are set up and the exact arguments to launch each one.

Then ask in plain words: "have Claude review this before we commit," "give the migration to Codex in the background," "get two independent opinions on whether this lock is safe."

## Getting results back

A foreground `delegate` streams the other agent's messages as it works, with a one-line note for each tool call. It doesn't dump the files the agent read or the output of commands it ran. For longer work, add `--background`: you get a job id immediately and collect the result when you want it.

```sh
consult wait --summary <job-id>    # block until done; one line with an answer preview and any patch path
consult result <job-id>            # the full final answer
consult logs <job-id> --tail 20    # what it did, step by step
consult status                     # recent jobs in this repository
```

Interrupting `wait` cancels the jobs it was waiting on. Pass `--keep-running` if you only want to stop waiting.

To ask a follow-up after a job finishes, reopen its conversation. The agent still has everything it read:

```sh
consult delegate --agent claude --resume-job <job-id> -- "Which of those would you fix first, and why?"
```

While a background job is running, `consult steer <job-id> -- "the schema is frozen; skip the migration"` redirects it without starting over, and `consult cancel <job-id>` stops it.

Job history (prompts, logs, and patches) stays on your machine. `consult clean` lists jobs older than 30 days, and `consult clean --apply` removes them.

## Code changes come back as patches

`--write` lets an agent edit your checkout directly. `--write --isolated` is usually the better choice: the agent works in a separate Git worktree that starts from your current state, including uncommitted changes and untracked files that aren't ignored. When it finishes, Consult saves a patch and a list of touched files, removes the worktree, and leaves your checkout alone.

```sh
consult wait --summary <job-id>                # includes the patch path
consult review --agent claude --job <job-id>   # a second agent reviews the patch
git apply <patch-path>                         # once you're satisfied
```

`review --job` gives the reviewer the original task, the worker's report, and the patch, so your session doesn't have to load the diff to get it reviewed. Reviewing with a different model than the one that wrote the change avoids shared blind spots. The same command reviews your own work: `consult review --agent codex` looks at your uncommitted changes, and `--base main` at everything since you branched.

On Linux, add `--allow-exec` so the worker can run tests and fix its own failures before it reports back. Its commands run without network access, under per-job memory, CPU, process, and time limits (`consult help authority` lists them). It can use the `node_modules` you've already installed but won't install packages. This needs cgroup v2 and a systemd user manager. Without `--allow-exec`, the worker can write tests, but you run them.

A completed job means the agent finished its turn. It doesn't mean the tests pass or the change is right, so read the report and check.

## Several jobs at once

A batch file starts up to eight background jobs in one call. Each entry can pick its own agent, model, and permissions:

```json
{
  "jobs": [
    { "label": "correctness", "agent": "claude", "prompt": "Review src/queue/retry.ts for bugs." },
    { "label": "tests", "agent": "codex", "prompt": "List the untested paths in src/queue/retry.ts." }
  ]
}
```

```sh
consult batch tasks.json
consult wait --batch <batch-id> --watch --summary
```

`consult wait <job-id> <job-id> --any` returns as soon as one of them finishes. `--after <job-id>` queues a job that starts only if another one succeeds, with the earlier answer added to its prompt. Consult doesn't cap how many jobs you run, so that part is up to you. Two independent reviewers usually tell you more than eight overlapping ones.

## Permissions

Every job starts read-only: the agent can read and search the repository but can't change it. Anything more is granted per job:

| Flags | What the agent can do |
| --- | --- |
| none, or `--read-only` | Read and search the repository |
| `--write` | Edit files in your checkout |
| `--write --isolated` | Edit a separate worktree and return a patch |
| `--write --isolated --allow-exec` | Also run tests and builds (Linux only) |
| `--allow-fetch` | Also reach public HTTPS sites, for web research |
| `--sandbox inherit` | Run as your user, without Consult's sandbox |

Claude and Codex run in an OS sandbox (bubblewrap on Linux, Seatbelt on macOS) with a private home directory, only the credential they need, and a proxy that passes traffic to their model provider and nowhere else. `--allow-fetch` and `--allow-exec` are only available to them. opencode, Pi, Copilot, and custom agents can't be confined this way yet, so Consult makes you pass `--sandbox inherit` for them. Consult still checks their requests against the job's permissions, but nothing at the OS level stops an agent that ignores those checks.

If a sandbox can't start, the job fails before it begins. Consult never retries with looser permissions.

Be deliberate with `--allow-fetch`. The agent holds a model credential, so a prompt injection in a page it reads could send your data somewhere else. Grant it only when the job needs the web. [SECURITY.md](SECURITY.md) describes the full trust model.

## Supported agents

| Agent | Sandboxed | Signs in with |
| --- | --- | --- |
| `claude` | Yes | Your Claude Code login, or `CONSULT_CLAUDE_OAUTH_TOKEN` or `CONSULT_CLAUDE_API_KEY` |
| `codex` | Yes | Your Codex login, or `CONSULT_OPENAI_API_KEY` |
| `opencode` | No | The providers configured in opencode |
| `pi` | No | The providers configured in Pi (0.84.4 or newer) |
| `copilot` (preview) | No | Your Copilot CLI login, or a GitHub token |
| Any ACP agent | No | Its own; see [custom profiles](docs/CUSTOM-PROFILES.md) |

On macOS, Claude Code keeps its login in the Keychain, which Consult doesn't pass into the sandbox. Run `claude setup-token` and export the token it prints as `CONSULT_CLAUDE_OAUTH_TOKEN`.

Use `claude` for Anthropic models, `codex` for OpenAI models, and opencode for everything else.

```sh
consult models --match grok     # find exact model ids across your agents
consult agents --set claude     # set a default so you can leave out --agent
```

## Documentation

`consult help` is the reference, and it always matches your installed version. `consult help <topic>` and `consult <command> --help` go deeper. The help and docs use a few terms precisely: the agent or terminal you're working in is the *Host*, an agent you delegate to is a *Profile*, and each delegation is a *Job*.

- [Usage reference](docs/USAGE.md): every command and option in long form
- [Install and troubleshooting](docs/INSTALL.md)
- [Security model](SECURITY.md) and [conformance reports](docs/conformance/README.md)
- [Glossary](CONTEXT.md), [architecture decisions](docs/adr/), and [roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

Consult is licensed under [Apache 2.0](LICENSE).
