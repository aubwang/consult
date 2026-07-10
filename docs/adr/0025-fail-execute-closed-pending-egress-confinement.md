# Fail execute closed pending egress confinement

Status: Accepted

Consult rejects `delegate --allow-exec` during argument validation and denies
ACP execute permission defensively even when an internal caller supplies
`allowExecute: true` under the existing bubblewrap backend.

The shipped bubblewrap policy is a hard filesystem boundary, but it shares the
Host network namespace. Arbitrary executed code can therefore reach loopback,
LAN, metadata, and internet destinations while the Profile process tree also
has access to its model credentials. Filesystem confinement alone is not a
sufficient execute boundary.

Execute may be enabled again only under a whole-Profile perimeter that blocks
direct networking, routes required Profile transport through an enforced
egress proxy, confines filesystem access, and passes process-tree cleanup and
live Profile conformance tests. Until then, retaining the flag as an explicit
fail-closed request is clearer and safer than silently accepting it or treating
the presence of `bwrap` as sufficient.

## Consequences

- Existing `--allow-exec` invocations now fail before Workspace discovery, Job
  creation, Profile launch, or model work.
- Internal foreground and Broker permission paths reject execute requests even
  if stale or hand-built payloads carry `allowExecute: true`.
- Transactional isolated write Jobs remain supported without execute authority.
- This supersedes only ADR-0024's execute grant. Its isolated-worktree and
  artifact decisions remain accepted.
