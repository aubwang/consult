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

Make the `consult` CLI available from this checkout:

```text
bun install
bun link
```

`npm install` and `npm link` also work if you prefer npm.

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

The first Codex adapter scope is delegate, status, result, and cancel. Setup
uses the same host-neutral CLI path but remains manual. Installer support,
Codex-native UI integration, and deep lifecycle hooks are not implemented yet.
