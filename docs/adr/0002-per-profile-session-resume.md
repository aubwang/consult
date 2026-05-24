# Per-profile, per-workspace session resume; sessionIds user-visible

Status: Superseded by [0016 Job-scoped Brokers with Host Session-scoped resume](0016-job-scoped-brokers.md)

`--resume` reattaches to the most recent finished job's session for the **currently selected profile in this workspace**. Cross-profile resume is not supported — a session lives inside one agent's internal state, so "resume my codex session in gemini" is incoherent.

The plugin tries `session/resume` first (broker still alive, fast, no replay noise), falls back to `session/load` if the agent advertises `loadSession` (history-replay rehydration), and errors out if neither is possible. The user sees one `--resume` flag; the protocol-level method is chosen internally.

`sessionId` is exposed to the user in `/consult:status` and `/consult:result` output. This is deliberate: each backend has its own escape hatch (`codex resume <id>`, `claude-agent-acp resume <id>`, etc.), and exposing the id lets users continue delegated work outside the plugin. The downside — the resume incantation differs per agent — is documented per profile in `/consult:agents`.
