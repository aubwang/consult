# Codex Host Adapter

The Codex Host Adapter is currently a thin manual wrapper over the
host-neutral `consult` CLI. It does not import broker or state modules.

It supplies this Host Identity:

```text
CONSULT_HOST=codex
CONSULT_HOST_SESSION_ID=<CONSULT_HOST_SESSION_ID || CODEX_THREAD_ID || default>
```

`default` is a synthetic Host Session id. Use a more specific value when Codex
exposes a stable session id to the wrapper. In current Codex sessions, the
wrapper uses `CODEX_THREAD_ID` when it is present.

## Manual setup

Make the `consult` CLI available from this checkout:

```text
npm install
npm link
```

Then use the package-provided Codex wrapper:

```sh
consult-codex help
```

`consult-codex` shells into the host-neutral `consult` CLI and sets the Codex
Host Identity first.

Install and select at least one Profile separately. Profile setup is shared
across Hosts:

```text
consult-codex setup
consult-codex agents --set codex --host codex
```

## Use

Delegate work:

```text
consult-codex delegate "summarize this repo"
```

Run a background job:

```text
consult-codex delegate --background "audit the permissions code"
```

Check status, read results, or cancel:

```text
consult-codex status
consult-codex result <job-id>
consult-codex cancel <job-id>
```

The first Codex adapter scope is delegate, status, result, and cancel. Setup
uses the same host-neutral CLI path but remains manual. Installer support,
Codex-native UI integration, and deep lifecycle hooks are not implemented yet.
