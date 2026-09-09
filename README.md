# Consult

[![npm](https://img.shields.io/npm/v/%40aubwang%2Fconsult?color=cb3837&logo=npm)](https://www.npmjs.com/package/@aubwang/consult)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Consult lets a coding agent delegate work to another agent through a CLI. Your current session can keep its context for planning and review while another agent investigates a question or prepares a patch.

The current environment is the **Host**. A configured agent is a **Profile**. Each delegation creates a **Job** with its own status, output, and activity log. Consult uses the [Agent Client Protocol](https://agentclientprotocol.com) and your installed agents.

Delegation separates working context. It can also add tokens, elapsed time, and review work. Use it for a bounded task that can proceed independently, and treat another agent's review as evidence to check.

## Quick start

You need Node.js 22.18 or newer on Linux or native Apple Silicon macOS. Linux confinement also needs bubblewrap, socat, and ripgrep. See the [installation guide](docs/INSTALL.md) for system requirements and namespace restrictions.

```sh
npm install --global @aubwang/consult
consult setup --install claude
consult doctor --agent claude

consult delegate --agent claude --read-only -- \
  "Inspect the retry logic. Report edge cases with file paths; do not edit."
```

Run these commands inside a Git repository. `doctor` checks the selected Profile in your current Host environment. A failure does not silently switch to broader permissions.

A Host can discover configured routes and exact model IDs without reading all
the help topics:

```sh
consult capabilities --configured --json
consult models --match grok --json
```

The configured summary starts no agents. Model discovery may initialize a
Profile or run its catalogue command, but sends no model prompt. Its JSON
includes exact launch arguments and authority requirements. Advertised models
still depend on your account access; see `consult models --help` for details.

## Prepare a change, then verify it

```sh
consult delegate --agent codex --write --isolated --background -- \
  "Add exponential backoff with jitter to the 429 retry path. Add a regression test. Report what changed and what still needs verification."

consult wait --summary <job-id>
consult result <job-id> --json
consult review --agent claude --job <job-id>
```

An isolated write Job starts from your committed, staged, unstaged, and supported untracked files in a separate Git worktree. Its result includes a patch and a touched-files manifest. Consult publishes successful completion after those artifacts are ready. If patch capture fails, it preserves the worktree and reports where to recover it.

The worktree is a source snapshot. Ignored dependency directories such as `node_modules` are omitted, and Consult does not provision a development environment there.

The Host reviews the patch, chooses whether to apply it, and runs the project's checks:

```sh
git apply --check /path/from/result/change.patch
git apply /path/from/result/change.patch
# Run this project's tests and inspect the resulting diff.
```

Delegates can write test code, but Consult currently denies general command execution. A completed Job means the agent finished its turn; it does not mean tests passed or the change is correct. `--isolated` rejects unresolved merge conflicts and nested repositories that a patch cannot capture faithfully.

## Profiles and authority

| Profile | Consult confinement | Authentication and current limits |
| --- | --- | --- |
| Codex | Linux and native arm64 macOS, subject to exact preflight | Staged Host login or `CONSULT_OPENAI_API_KEY`; reopening depends on the installed adapter |
| Claude | Linux and native arm64 macOS, subject to exact preflight | Staged Host login, `CONSULT_CLAUDE_OAUTH_TOKEN`, or `CONSULT_CLAUDE_API_KEY`; automatic Host refresh requires claude-agent-acp 0.59.0+ |
| opencode | Explicit `--sandbox inherit` | Uses the Host environment and native authentication |
| Copilot | Explicit `--sandbox inherit`; preview support | CLI 1.0.60+; model-turn conformance remains authentication-deferred; resume is disabled |
| Custom ACP Profile | Explicit `--sandbox inherit` | User-configured executable and authentication; see [custom Profiles](docs/CUSTOM-PROFILES.md) |

Read-only confinement is the default. Writes require `--write`; arbitrary public network access requires `--allow-fetch`. General command execution remains unavailable. Confined Jobs cannot create nested Consult Jobs.

`--sandbox inherit` runs with the Host's ambient authority. Its permission checks are cooperative: they cannot contain an uncooperative backend or its startup hooks. Choose it explicitly when that tradeoff fits your environment. Native Windows and macOS x64 processes are unsupported. WSL2 uses the Linux path.

An outer Host sandbox can prevent Consult from starting its own boundary. In particular, a successful terminal check on macOS does not establish support inside a sandboxed Codex Host. Check the [conformance reports](docs/conformance/README.md) and run `doctor` where you intend to delegate.

## Keeping the Host's context small

Background Jobs return an id immediately. `wait --summary` prints an output preview and artifact paths; `result` returns the stored agent text. Previews use the end of the available output and are not a separately verified final report. Foreground Jobs stream agent messages and tool progress. Full activity is available through `logs`.

The Host chooses how much work to launch. Consult has no global concurrency quota, and Jobs waiting on dependencies still occupy workers.

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
