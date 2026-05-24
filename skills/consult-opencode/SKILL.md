---
name: consult-opencode
description: Use from opencode when the user wants Consult delegation commands such as delegate, status, result, or cancel. Provides the opencode Host Adapter wrapper over the host-neutral consult CLI.
---

# Consult opencode Host Adapter

Use this skill from opencode to invoke Consult through the `consult-opencode`
wrapper. This adapter is intentionally thin: it supplies opencode Host Identity
and does not read or import Consult broker or state internals.

## Host Identity

Run Consult commands through:

```sh
consult-opencode <command> ...
```

The wrapper sets `CONSULT_HOST=opencode`. It uses `CONSULT_HOST_SESSION_ID`
when explicitly set, otherwise `OPENCODE_SESSION_ID` when available, otherwise
`OPENCODE_RUN_ID` when opencode provides it, otherwise `default`.

## Commands

Supported first:

- `delegate`: delegate a prompt to the selected Profile.
- `status`: show all jobs in the Workspace or one Job by id.
- `result`: show the final stored output for a completed Job.
- `cancel`: cancel a queued or running Job.

Examples:

```sh
consult-opencode delegate --agent claude --read-only -- "review this diff"
consult-opencode delegate --agent opencode --read-only -- "summarize this repo"
consult-opencode status
consult-opencode result job-id
consult-opencode cancel job-id
```

Forward user arguments directly to `consult-opencode`. Do not inspect
`~/.consult/workspaces`, job JSON, broker endpoint files, or modules under
`scripts/lib`; the CLI is the adapter boundary.

## Manual Setup

Until an installer exists:

1. Put the host-neutral CLI on `PATH`, for example by running `npm link` from the
   Consult repo or by adding the repo's `bin` directory to `PATH`.
2. Make this skill visible to opencode by copying or symlinking
   `skills/consult-opencode` into an opencode skill directory, such as
   `.opencode/skills/consult-opencode` for this project or
   `~/.config/opencode/skills/consult-opencode` globally.
3. Configure Profiles with the Consult CLI before first delegation, for example:

```sh
consult-opencode setup
consult-opencode setup --install opencode
consult-opencode agents --set opencode --host opencode
```
