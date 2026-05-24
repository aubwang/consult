---
name: consult-codex
description: Use from Codex when the user wants Consult delegation commands such as delegate, status, result, or cancel. Provides the Codex Host Adapter wrapper over the host-neutral consult CLI.
metadata:
  "consult.disable-model-invocation": "true"
---

# Consult Codex Host Adapter

Use this skill from Codex to invoke Consult through the `consult-codex` wrapper.
This adapter is intentionally thin: it supplies Codex Host Identity and does not
read or import Consult broker or state internals.

## Host identity

Run Consult commands through:

```sh
consult-codex <command> ...
```

The wrapper sets `CONSULT_HOST=codex`. It uses `CONSULT_HOST_SESSION_ID` when
explicitly set, otherwise `CODEX_THREAD_ID` when Codex provides it, otherwise
`default`.

## Commands

Supported first:

- `delegate`: delegate a prompt to the selected Profile.
- `status`: show all jobs in the Workspace or one Job by id.
- `result`: show the final stored output for a completed Job.
- `cancel`: cancel a queued or running Job.

Examples:

```sh
consult-codex delegate --agent codex "summarize this repo"
consult-codex status
consult-codex result job-id
consult-codex cancel job-id
```

Forward user arguments directly to `consult-codex`. Do not inspect
`~/.consult/workspaces`, job JSON, broker endpoint files, or modules under
`scripts/lib`; the CLI is the adapter boundary.

## Manual setup

Until an installer exists:

1. Put the host-neutral CLI on `PATH`, for example by running `npm link` from the
   Consult repo or by adding the repo's `bin` directory to `PATH`.
2. Make this skill visible to Codex by copying or symlinking
   `skills/consult-codex` into `$CODEX_HOME/skills/consult-codex`.
3. Configure Profiles with the Consult CLI before first delegation, for example:

```sh
consult-codex setup
consult-codex setup --install codex
consult-codex agents --set codex --host codex
```
