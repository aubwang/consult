# opencode Host Adapter

The opencode Host Adapter is a thin manual wrapper over the host-neutral
`consult` CLI. It does not import broker or state modules.

It supplies this Host Identity:

```text
CONSULT_HOST=opencode
CONSULT_HOST_SESSION_ID=<CONSULT_HOST_SESSION_ID || OPENCODE_SESSION_ID || OPENCODE_RUN_ID || default>
```

`default` is a synthetic Host Session id. When opencode exposes
`OPENCODE_RUN_ID`, the wrapper uses it if no explicit
`CONSULT_HOST_SESSION_ID` or future `OPENCODE_SESSION_ID` is set.

## Manual setup

Make the `consult` CLI available from this checkout:

```text
npm install
npm link
```

Then use the package-provided opencode wrapper:

```sh
consult-opencode help
```

`consult-opencode` shells into the host-neutral `consult` CLI and sets the
opencode Host Identity first.

Install and select at least one Profile separately. Profile setup is shared
across Hosts:

```text
consult-opencode setup
consult-opencode agents --set opencode --host opencode
```

## Use

Delegate work:

```text
consult-opencode delegate --agent claude --read-only -- "review this diff"
```

Run a background job:

```text
consult-opencode delegate --agent opencode --read-only --background -- "audit the permissions code"
```

Check status, read results, or cancel:

```text
consult-opencode status
consult-opencode result <job-id>
consult-opencode cancel <job-id>
```

The first opencode adapter scope is delegate, status, result, and cancel. Setup
uses the same host-neutral CLI path but remains manual. Installer support,
opencode-native UI integration, and deep lifecycle hooks are not implemented
yet.
