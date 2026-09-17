# Consult

[![npm](https://img.shields.io/npm/v/%40aubwang%2Fconsult?color=cb3837&logo=npm)](https://www.npmjs.com/package/@aubwang/consult)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Consult lets a coding agent delegate work to another agent through a CLI. The main session is "protected" from the subagent's working context and scratchpad, and only sees the subagent's report or end results.

This way, your current session can preserve its context for planning and review while another agent investigates a question or prepares a patch. If needed, the main agent can access the subagent's context through the CLI, or reprompt the subagent. 

Consult uses the [Agent Client Protocol](https://agentclientprotocol.com) and your installed agents. 

## Quick start

```sh
npm install --global @aubwang/consult
consult setup --install claude
consult doctor --agent claude

consult delegate --agent claude --read-only -- \
  "Inspect the retry logic. Report edge cases with file paths; do not edit."
```

The CLI supports Node.js 22.18+ on Linux or Apple Silicon macOS. Linux confinement also needs bubblewrap, socat, and ripgrep. See the [installation guide](docs/INSTALL.md) for system requirements and namespace restrictions.

Some terminology:

The current environment is the **Host**. A configured agent is a **Profile**. Each delegation creates a **Job** with its own status, output, and activity log.

Consult requires that a Git repo is initiated in your current directory. `doctor` checks for which Profiles are configured in your current Host environment.

A Host can discover configured routes and exact model IDs without reading all
the help topics:

```sh
consult capabilities --configured --json
consult models --match grok --json
```

Claude and OpenAI models use their native adapters by default; opencode serves other providers
unless explicitly selected. Native auth failures are reported without rerouting.
Advertised models still depend on your account access; see `consult models --help` for details.

## Prepare a change, then verify it

```sh
consult delegate --agent codex --write --isolated --allow-exec --background -- \
  "Add exponential backoff with jitter to the 429 retry path. Add and run a regression test. Fix failures and report exact commands and outcomes."

consult wait --summary <job-id>
consult result <job-id> --json
consult review --agent claude --job <job-id>
```

An isolated write Job starts from your committed, staged, unstaged, and supported untracked files in a separate Git worktree. Its result includes a patch and a touched-files manifest. Consult publishes successful completion after those artifacts are ready. If patch capture fails, it preserves the worktree and reports where to recover it.

The Host reviews the patch, chooses whether to apply it, and runs the project's checks:

```sh
git apply --check /path/from/result/change.patch
git apply /path/from/result/change.patch
# Run this project's tests and inspect the resulting diff.
```

On Linux, `--write --isolated --allow-exec` lets confined Codex and Claude workers run tests and repair failures within their turn. Eligible installed `node_modules` are copied into the worktree independently (up to 1 GiB and 100000 entries). It requires cgroup v2, a working systemd user manager, and prlimit. By default, each execute launch is limited to 4 GiB memory, 256 tasks, 200% CPU, 64 MiB per file, and 30 minutes. 

Without this grant, delegates can write tests but cannot run commands. A completed Job means the agent finished its turn; it does not mean tests passed or the change is correct. `--isolated` rejects unresolved merge conflicts and nested repositories that a patch cannot capture faithfully.

## Profiles and authority

| Profile | Consult confinement | Authentication and current limits |
| --- | --- | --- |
| Codex | Linux and native arm64 macOS, subject to exact preflight | Staged Host login or `CONSULT_OPENAI_API_KEY`; reopening depends on the installed adapter |
| Claude | Linux and native arm64 macOS, subject to exact preflight | Staged Host login, `CONSULT_CLAUDE_OAUTH_TOKEN`, or `CONSULT_CLAUDE_API_KEY`; automatic Host refresh requires claude-agent-acp 0.59.0+ |
| Pi | Explicit `--sandbox inherit` | Native Pi 0.84.4+ via Consult’s internal RPC bridge; native provider configuration and login |
| opencode | Explicit `--sandbox inherit` | Uses the Host environment and native authentication |
| Copilot | Explicit `--sandbox inherit`; preview support | CLI 1.0.60+; model-turn conformance remains authentication-deferred; resume is disabled |
| Custom ACP Profile | Explicit `--sandbox inherit` | User-configured executable and authentication; see [custom Profiles](docs/CUSTOM-PROFILES.md) |

Read-only confinement is the default. Writes require `--write`; arbitrary public network access requires `--allow-fetch`. Execute requires `--write --isolated --allow-exec` and the supported Linux boundary; Confined Jobs cannot create nested Consult Jobs.

`--sandbox inherit` runs with the Host's ambient authority. Its permission checks are cooperative: they cannot contain an uncooperative backend or its startup hooks. Choose it explicitly when that tradeoff fits your environment.

An outer Host sandbox can prevent Consult from starting its own boundary. In particular, a successful terminal check on macOS does not establish support inside a sandboxed Codex Host. Check the [conformance reports](docs/conformance/README.md) and run `doctor` where you intend to delegate.

## Parallel Jobs and practical workflows

`consult help workflows` teaches worker/test/reviewer loops and bounded fan-out.
To launch independent Jobs, put `{"jobs":[{"label":"correctness","prompt":"Review src/retry.mts for bugs."},{"label":"tests","prompt":"Review retry test coverage."}]}` in `tasks.json`, then:

```sh
consult batch tasks.json --agent claude
consult wait --batch <batch-id> --watch --summary
consult wait <job-a> <job-b> --any --json --timeout 60
```

A batch holds up to eight Jobs, each with independent results and cancellation.
Partial submission failures preserve a receipt with launched Job ids. Each
writer must explicitly set `"write": true, "isolated": true`. `--watch` prints
status changes; `--any` returns when one selected Job finishes. A timeout leaves
Jobs running. `wait --active` snapshots active Jobs for the current Host Session.


## Keeping the Host's context small

Background Jobs return an id immediately. `wait --summary` prints an output preview and artifact paths; `result` returns the stored agent text. Previews use the end of the available output and are not a separately verified final report. Foreground Jobs stream agent messages and tool progress. Full activity is available through `logs`.

The Host chooses how much work to launch. Consult has no global concurrency quota, and Jobs waiting on dependencies will still occupy workers.

```sh
consult status
consult logs <job-id> --tail 20
consult logs <job-id> --follow
consult cancel <job-id>
consult clean --older-than 30d          # preview old history cleanup
consult clean --older-than 30d --apply  # remove eligible history and artifacts
```

Interrupting `consult wait` cancels its active Jobs by default. Use `--keep-running` when you want interruption to stop waiting while work continues.

Job history stays on your machine until you remove it. Logs, prompts, saved sessions, and patches may contain private project data. Cleanup preserves recovery worktrees and dependencies needed by retained Jobs. See [security and trust boundaries](SECURITY.md).

## More detail

`consult help` gives the overview. `consult help delegate`, `consult help authority`, and the other help topics carry the operating guidance that an agent Host needs; no Host plugin or skill installation is required.

- [Usage and contracts](docs/USAGE.md)
- [Install and troubleshoot](docs/INSTALL.md)
- [Domain glossary](CONTEXT.md) and [architecture decisions](docs/adr/)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and [roadmap](docs/ROADMAP.md)

Consult is licensed under [Apache 2.0](LICENSE).
