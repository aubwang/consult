# Codex Host Autodetection

Codex uses the single `consult` CLI. There is no separate Codex wrapper
binary.

When `CODEX_THREAD_ID` is present and no explicit Host override is supplied,
Consult records this Host Identity:

```text
host=codex
hostSessionId=<CODEX_THREAD_ID>
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
consult agents --set codex --host codex
```

## Use

Delegate work:

```text
consult delegate "summarize this repo"
```

Run a background Job:

```text
consult delegate --background "audit the permissions code"
```

Check status, read results, or cancel:

```text
consult status
consult result <job-id>
consult cancel <job-id>
```

Host autodetection is intentionally the only Codex-specific integration. Setup,
review, isolated writes, status, result, logs, chain, and cancellation all use
the same host-neutral CLI path.
