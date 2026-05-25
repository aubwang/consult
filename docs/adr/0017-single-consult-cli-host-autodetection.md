# Single consult CLI with Host autodetection

Status: Accepted

Consult ships one user-facing CLI binary: `consult`. It does not ship
Host-specific wrapper binaries such as `consult-codex` or `consult-opencode`.

The shared Host identity resolver keeps explicit flags and explicit Consult env
vars as overrides, then autodetects known Host session variables:

- `OPENCODE_SESSION_ID` or `OPENCODE_RUN_ID` -> `opencode`
- `CODEX_THREAD_ID` -> `codex`
- `CLAUDE_SESSION_ID` -> `claude-code`
- otherwise `terminal/default`

We chose this because the command users type should not change based on the
Host they are currently in. Host-specific wrappers made the Host/Profile split
harder to explain: users had to remember one command for where the request came
from and another flag for where it should go. With Host autodetection, the
command shape is stable and the Profile remains the only routine choice:
`consult delegate --agent <profile> ...`.

Explicit `--host`, `--host-session`, `CONSULT_HOST`, and
`CONSULT_HOST_SESSION_ID` remain available for smoke tests, unusual host
embedding, and manual recovery. Host-specific integrations may still provide
native slash commands or skills, but they should call the same `consult` CLI or
the same companion subcommands rather than introducing new wrapper binaries.

## Consequences

- Package metadata exposes only the `consult` binary.
- Codex and opencode command examples use `consult` directly.
- Existing Host-specific wrapper tests are removed; Host detection is covered at
  the shared resolver seam.
- If multiple Host-specific env vars are inherited, the resolver treats
  opencode as the most local signal, then Codex, then Claude Code. Explicit
  overrides remain the escape hatch.
