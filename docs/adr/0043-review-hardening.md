# ADR 0043: Job publication and local state ownership

## Status

Accepted.

## Decision

Keep the CLI, ACP transport, and isolated-worktree design. Tighten their existing boundaries and make their limits visible in the CLI and documentation.

A successful terminal Job record requires a completed Profile turn, disposed Profile processes, and any required isolated artifacts. Isolated finalization runs before terminal publication. If capture fails, preserve the worktree and publish a failed result with its recovery path. Only `end_turn` is successful; refusal and limit stops cannot start dependent work.

Serialize Job record changes under a Workspace history mutex. Cancellation wins a concurrent completion, terminal Jobs cannot return to queued or running, and retention cannot race record replacement. Serialize log appends separately per Job. Atomic rename continues to prevent torn record files.

The mutex uses local filesystem claims and Lamport's bakery ordering. Each acquisition has a unique claim path; stale claims are removed only when their recorded process identity no longer exists. A live owner is never evicted by age. A wait timeout fails that operation. This avoids deleting a replacement owner's lock during stale-lock recovery. The contract requires coherent local directory reads and same-directory atomic rename; network filesystems are unsupported.

Retention is explicit through `consult clean`, with preview as the default. It preserves live processes, recovery worktrees, and dependencies needed by retained Jobs. Small tombstones prevent stale writes or new dependency records from referring to removed history. Malformed records block destructive cleanup. Inspection may return valid records with explicit corruption warnings; cancellation remains strict so it cannot silently omit a child.

Host filesystem callbacks open validated regular files through descriptors. Linux pins directory components; macOS rejects symlinks in every component at open time. Git metadata writes and writes through hard links are denied. Confined native filesystem policy protects Workspace `.git` and explicitly masks Linux `/sys`.

Proxy credentials travel in the child environment. Profile environment values travel to a Broker through a pipe. ACP input frames are bounded before SDK decoding. Permission responses use one-call grants only; an unrecognized Session or tool operation does not receive ambient fallback authority.

## Consequences

The design still has one JSON record per Job. Relationship construction is linear, reads have bounded concurrency, and log follow is incremental. Explicit retention bounds the history users choose to keep. A database can be reconsidered if measurements show that file discovery, rather than relationship scans or log rereads, becomes the limiting cost.

Compatibility changes are intentional: unknown stop reasons now fail, unsupported index states are rejected, `.git` writes are unavailable, and summary text is labeled as a preview. The additive recovery field remains within Job Result schema v1. `--base` consistently includes current tracked changes against the merge base.

Process identity checks reduce stale-PID risk but do not provide a kernel process handle. macOS identity precision and native conformance must be assessed on macOS; Linux execution cannot establish those results. General execution and portable resource quotas remain outside this change.
