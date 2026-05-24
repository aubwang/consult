# Opt-in bubblewrap agent sandbox

Consult should keep the default ACP agent launch path unchanged, and expose the
workspace filesystem sandbox as opt-in with `CONSULT_AGENT_SANDBOX=bwrap`.

We chose opt-in because real ACP backends often need host auth/config files from
the user's home directory. Enabling a mount namespace by default would make
those profiles fail until Consult grows explicit, profile-aware config mounts.

When enabled, the Broker launches the ACP agent through bubblewrap. Read-only
Jobs bind the Workspace read-only; write Jobs bind the Workspace read-write; the
Broker restarts the agent when the next Job needs a different sandbox write
mode.
