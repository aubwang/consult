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

Install the supported npm package:

```text
npm install --global @aubwang/consult
```

Install and select at least one Profile separately. Profile setup is shared
across Hosts:

```text
consult setup
consult agents --set codex --host codex
consult doctor --agent codex
```

Consult-managed confinement is the default, but a second native sandbox may be
rejected when Consult itself runs inside an already-confined Codex Host. Doctor
reports that condition before a Job is created. Prefer delegation from an
unrestricted sibling terminal when a hard child boundary is required; use
`--sandbox inherit` only when the trusted Host deliberately accepts ambient
authority. Consult never retries with inheritance automatically.

Native macOS support is Apple Silicon only. Intel macOS fails preflight,
including inherited mode.

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
