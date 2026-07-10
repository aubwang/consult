# opencode Host Autodetection

opencode uses the single `consult` CLI. There is no separate opencode wrapper
binary.

When `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` is present and no explicit Host
override is supplied, Consult records this Host Identity:

```text
host=opencode
hostSessionId=<OPENCODE_SESSION_ID || OPENCODE_RUN_ID>
```

Use `--host` / `--host-session` or `CONSULT_HOST` /
`CONSULT_HOST_SESSION_ID` only for smoke tests and manual overrides.

## Manual setup

Install the current GitHub version:

```text
npm install --global github:aubwang/consult
```

Install and select at least one Profile separately. Profile setup is shared
across Hosts:

```text
consult setup
consult agents --set opencode --host opencode
```

## Use

Delegate work:

```text
consult delegate --agent claude --read-only -- "review this diff"
```

Run a background Job:

```text
consult delegate --agent opencode --read-only --sandbox inherit --background -- "audit the permissions code"
```

Check status, read results, or cancel:

```text
consult status
consult result <job-id>
consult cancel <job-id>
```

Host autodetection is intentionally the only opencode-specific integration.
Setup, review, isolated writes, status, result, logs, chain, and cancellation
all use the same host-neutral CLI path.
