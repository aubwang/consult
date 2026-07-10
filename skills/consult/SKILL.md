---
name: consult
description: Use Consult delegation commands such as delegate, status, result, cancel, agents, setup, or brokers from any Host. The consult CLI autodetects Codex and opencode Host identity from the environment.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult

Use this skill to invoke Consult through the single `consult` CLI. Do not use
Host-specific wrapper commands.

## Host Identity

Run Consult commands directly:

```sh
consult <command> ...
```

The CLI resolves Host identity in this order:

1. Explicit `--host` / `--host-session` flags.
2. `CONSULT_HOST` / `CONSULT_HOST_SESSION_ID` environment variables.
3. Known Host session variables:
   - `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` -> `opencode`
   - `CODEX_THREAD_ID` -> `codex`
4. `terminal/default`.

Claude Code has no product Host Adapter or stable auto-detected session
variable. A Claude spawning Host must pass `--host claude-code
--host-session <stable-session-id>` (or set the two `CONSULT_*` variables), or
its Jobs intentionally fall into the shared `terminal/default` scope.

## Commands

Supported first:

- `delegate`: delegate a prompt to the selected Profile.
- `status`: show all Jobs in the Workspace or one Job by id.
- `result`: show the final stored output for a completed Job.
- `cancel`: cancel a queued or running Job.
- `agents`: list or set configured Profiles.
- `setup`: install or verify Profiles.
- `brokers`: inspect live Broker locators and clean stale Broker state.
- `review`: run a pinned, read-only review through any configured Profile.

Examples:

```sh
consult delegate --agent claude --read-only -- "review this diff"
consult delegate --agent opencode --read-only --sandbox inherit -- "summarize this repo"
consult delegate --agent codex --read-only --include-diff -- "look for missed edge cases"
consult review --agent claude --base main
consult delegate --agent codex --write --isolated -- "implement the focused fix"
consult status
consult result job-id
consult cancel job-id
```

For the full operational contract — flag semantics, `--json` output shapes,
exit codes, model selection, and polling and resume behavior — run
`consult help`.

Forward user arguments directly to `consult`. Do not inspect
`~/.consult/workspaces`, job JSON, broker endpoint files, or modules under
`scripts/lib`; the CLI is the adapter boundary.

## Manual Setup

1. Put the Consult CLI on `PATH` with
   `npm install --global @aubwang/consult`; repository developers may instead
   run `bun link` from a checkout.
2. Make this skill visible to the Host by copying or symlinking `skills/consult`
   into the Host's skill directory.
3. Configure Profiles with the Consult CLI before first delegation, for example:

```sh
consult setup
consult setup --install codex
consult agents --set codex --host codex
consult doctor --agent codex
```

## Safety Defaults

- Delegation defaults to read-only, Consult-managed confinement. Built-in
  `codex` and `claude` Profiles are confined on native Linux and macOS after an
  exact Profile preflight; a failed preflight creates no Job.
- `consult doctor` runs that live preflight: it briefly stages the selected
  credential and initializes/disposes the Profile, but sends no model prompt.
- Use `--include-diff` or `review` when the Profile needs an immutable snapshot
  of current changes.
- When edits are explicitly requested, prefer `--write --isolated`; Consult
  returns a patch artifact without changing the invoking checkout.
- Add `--allow-fetch` only when task-specific public TCP/443 research is worth
  delegating. The Profile holds its selected model credential, so fetch
  increases prompt-injection exfiltration risk; the Host may search instead.
- `--sandbox inherit` is a deliberate trusted-Host escape hatch with no Consult
  OS boundary. Read-only and path checks are then cooperative/detective: a
  Profile backend may act before Consult observes a violation. Never retry with
  inheritance silently after confined preflight fails.
- Custom and `opencode` Profiles currently require explicit inheritance.
  Confined nested delegation and native Windows (including inheritance) are
  unsupported.
- Do not pass `--allow-exec`; execute-specific resource limits and
  cross-Profile conformance remain incomplete, so it fails preflight.
- Prefer `--json` when parsing Job output. Public Job JSON is versioned and
  grouped under `job`, `outcome`, `artifacts`, and `lineage`.
