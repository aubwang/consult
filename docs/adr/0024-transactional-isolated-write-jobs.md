# Transactional isolated write Jobs and sandbox-gated execution

Status: Accepted

Consult adds opt-in `delegate --write --isolated`. It creates a detached Git
worktree under Consult-owned Workspace state, seeds that Execution Workspace
from the caller's staged, unstaged, and safe nonignored untracked files, and
snapshots the seed as a baseline. The Profile runs with the detached worktree
as cwd while Job records, logs, resume identity, and lineage remain keyed by
the original Workspace.

After the prompt turn, Consult compares the final tree to the seeded baseline,
writes an agent-only binary patch and touched-files manifest, persists those
artifact paths on the Job, and removes the worktree in cleanup. It never
applies the patch to the invoking checkout automatically. In-place `--write`
remains available for compatibility; `--isolated` requires explicit write
mode.

Consult also adds explicit `--allow-exec`, valid only with `--write
--isolated`. The ACP permission handler grants an execute request only when the
run payload carries literal `allowExecute: true`, the request cwd is confined
to the Execution Workspace, and the normalized active process sandbox is
`bwrap`. Execute stays denied in read-only, in-place, unsandboxed, and
non-opted-in Jobs. Fetch stays denied in every mode. Permission-relevant opt-in
is part of Broker payload identity.

This design gives agentic implementation Jobs a reviewable transaction without
requiring proprietary session servers or mutating the user's checkout. Git
worktrees alone are not a hard security boundary, because a Profile can launch
native tools or report edits after they happen. Bubblewrap is therefore a
separate hard filesystem boundary and the only context in which raw execute
permission is enabled.

## Consequences

- The Workspace and the Profile's Execution Workspace can differ; code must
  pass them separately rather than changing state identity to the worktree.
- Dirty tracked state is reconstructed with binary patches. Only regular safe
  untracked files are copied. Ignored files are skipped; symlinks, traversal,
  special files, and invalid path encodings are rejected.
- Gitignored files are intentionally absent from both the seed and final
  artifact. Output written to ignored paths is not captured. A repository must
  have at least one commit to provide the detached-worktree base.
- Isolated background Jobs may run the shared inline runtime inside their
  detached worker so one process owns both the Execution Workspace and Job
  lifetime. Cancellation uses the recorded runner pid.
- Patch and touched-files artifacts outlive worktree cleanup. Artifact
  retention and any future apply command are separate concerns.
- `--allow-exec` fails closed when bubblewrap is unavailable or inactive; the
  flag alone conveys no authority.

This extends ADR-0015's opt-in bubblewrap sandbox and ADR-0021's inline runner.
