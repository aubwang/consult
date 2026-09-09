# Security

Consult runs installed agent software and handles local credentials. Its authority controls limit delegated work, but their guarantees depend on the selected mode and Host environment.

## Report a problem

Please use [GitHub private vulnerability reporting](https://github.com/aubwang/consult/security/advisories/new) for a suspected boundary escape or credential disclosure. If that channel is unavailable, open an issue asking for a private reporting route without posting exploit details or sensitive data.

Include the Consult version, OS and architecture, Node version, Profile and adapter versions, Host context, authority flags, and a minimal reproduction using synthetic data. State whether the effect crosses an OS boundary, a Host filesystem callback, or a cooperative permission check. Remove credentials, prompts, and private paths from logs before sharing them.

Security fixes target the current release. There is no commitment to maintain older release lines or a fixed response time.

## Trust boundaries

Confined Codex and Claude Jobs get a private credential snapshot and restricted filesystem and network access. Exact preflight must pass in the invoking Host. General command execution is denied. Workspace Git metadata is protected from delegated writes. Host filesystem callbacks reject paths outside the Workspace, unsafe symlinks, and writes through multiply-linked files.

An inherited Job runs with the Host's ambient authority. ACP permission checks and violation detection remain useful, but they are not an OS sandbox. The agent, its startup hooks, and the local user are trusted in that mode. Same-user access to Consult state is not an isolation boundary.

Credentials remain readable by the Profile process that needs them. Proxy authentication values travel through the child environment, and Profile environment values travel to the Broker through a pipe. This avoids exposing them in Consult's launch arguments; it does not hide them from privileged or same-user process inspection. `--allow-fetch` expands the destinations a credential-bearing process can contact.

A root Claude Job may refresh the Host login before Job creation. This happens in a private directory with project settings, hooks, and MCP configuration disabled for the refresh session. It is announced on stderr and requires a supported adapter. Consult sends no model prompt during refresh. Nested Jobs and diagnostic commands do not refresh credentials.

## State and recovery

Job records and log appends are serialized on a coherent local filesystem. Keep `CONSULT_DATA_DIR` on local storage; network filesystem locking and cache semantics are outside the supported contract. Cancellation checks recorded process identity before signaling. These checks reduce PID reuse risk; they are not kernel process handles, and macOS start-time precision remains limited by `ps`.

A successful isolated Job has its artifacts ready before completion is published. Patch-capture failures preserve the worktree. Review patches and run checks in the Host before integrating changes; completion is not a correctness or test attestation.

Prompts, logs, saved agent sessions, patches, and recovery worktrees can contain private project data. Nothing is uploaded by the history commands. `consult clean` previews eligible expired history; `--apply` removes it. Recovery worktrees and retained dependencies are excluded. Malformed history produces a diagnostic, and malformed log entries are never silently skipped.

Resource controls are partial: Consult bounds transport frames, stored text, log growth, and Job wall time. It does not provide portable CPU, memory, process-count, or total disk quotas. The filesystem boundary also assumes the trusted Host does not move an open Workspace directory out of its boundary while a delegated file operation is in progress.
