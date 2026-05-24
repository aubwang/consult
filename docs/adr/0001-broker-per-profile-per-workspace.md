# Broker per (host, host-session, profile, workspace), implemented as a Unix-socket daemon

Status: Superseded by [0016 Job-scoped Brokers with Host Session-scoped resume](0016-job-scoped-brokers.md)

Each (**Host**, **Host Session**, **Profile**, **Workspace**) tuple runs a long-lived **Broker** — a separate `node consult-broker.mjs serve` process that owns the ACP-agent child, the JSON-RPC connection, and the `ClientSideConnection` from `@agentclientprotocol/sdk`. Short-lived companion CLI invocations connect to the daemon over a Unix-domain socket and forward work. Brokers are spawned lazily on first command use; shut down cooperatively via `broker/shutdown` RPC from a Host Adapter lifecycle hook when available, with forced `terminateProcessTree` as a backstop; and stale-detected-then-respawned on next use if found dead.

We chose this over fresh-spawn-per-command because every command paying agent cold-start (1–3 s per call for codex-acp / claude-agent-acp) compounds badly across interactive `/consult:delegate` and tight `/consult:status` loops, and because protocol-level `session/resume` only works while the agent's session state is still in memory — which requires the agent process to outlive the companion that started it.

We chose the daemon-plus-IPC shape over "spawn agent and hold pipes inside the companion" because the companion exits after each slash command, taking the stdio pipes with it; persisting pids without an out-of-band IPC channel does not preserve the JSON-RPC transport. The codex plugin's `app-server-broker.mjs` is our reference implementation for this exact problem.

We chose per-(Host, Host Session, Profile, Workspace) over per-(Profile, Workspace) — the more obvious model — because lifecycle events are Host-session scoped when a Host exposes them. With per-workspace scoping, closing one Host session in a repo would tear down brokers being actively used by another Host session in the same repo. Including Host Identity in the scope localizes teardown to the session that owned the spawn. The cost is doubled broker count when a user opens two Host sessions in the same repo simultaneously; for the single-session case (the common case) the count is unchanged.

## Consequences

- A user running two Profiles in two repos has four broker processes idle in the background. Documented; not a leak.
- A user with two Host sessions open in the same repo gets two brokers per Profile, not one. Trade-off accepted: each session has clean shutdown semantics.
- Two foreground delegates against the same (Host, Host Session, Profile, Workspace) serialize at the broker via the `BROKER_BUSY` mutex (inherited from codex). Control-plane methods (`consult/cancel`, `broker/shutdown`, `consult/ping`) bypass the mutex so cancel and shutdown can interrupt an in-flight prompt — without this, `/consult:cancel` would queue behind the prompt it's trying to interrupt.
- The broker is the most failure-prone surface in the plugin (subprocess + IPC + agent stdio + session state). The conformance checks in `docs/conformance/` and the broker lifecycle tests cover delegate-exits-then-resume behavior across companion processes; this is the load-bearing proof that the daemon model is wired correctly.
