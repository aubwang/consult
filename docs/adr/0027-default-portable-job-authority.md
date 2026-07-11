# Default portable Job Authority

Status: Accepted

Supersedes: ADR-0015 (opt-in bubblewrap agent sandbox)

## Context

Delegated Profiles are cold, unattended processes that inspect untrusted
Workspace content. ACP permission requests and Job policy are useful
cooperative controls, but real Profiles may perform actions before or without
an ACP request. The previous optional bubblewrap layer constrained only Linux
filesystem access, shared Host networking, exposed Profile configuration by
mount, and failed unpredictably when nested under an already-sandboxed Host.

Consult needs one Host-visible authority contract whose meaning survives the
foreground/Broker split and whose unsupported combinations fail before any Job
or isolated Workspace is created. It also needs task-specific web research
without making direct egress the default.

## Decision

Consult defines canonical Job Authority schema v1 with mode, confinement,
fetch, and execute fields. The default is read-only, confined, no fetch, and no
execute. Write, public-TCP/443 fetch, and ambient inheritance require explicit
Host choices. The canonical object is persisted and included in Job payload
identity; runtime boundaries compare it rather than reconstructing authority
from legacy flags.

Before Job creation, Consult initializes the exact selected ACP Profile inside
the requested boundary. Native Linux and native arm64 macOS confinement is
available only for built-in Codex and Claude Profile identities after
combination-specific conformance. Native Windows and macOS x64 processes are
unsupported, including inheritance. Confined
nesting is unsupported. Custom and opencode Profiles require explicit
inheritance until separately proven.

Preflight is advisory compatibility evidence rather than a TOCTOU guarantee.
The launch path re-derives and validates the boundary, so a changed Profile
binary or credential can fail after Job creation but cannot inherit broader
authority silently. `consult doctor` performs this same live ACP initialization
with real staged credentials and temporary proxy listeners; it is not a
metadata-only command.

`--sandbox inherit` means Consult adds no OS boundary. It is a deliberate
trusted-Host choice, never an automatic fallback from failed confinement. The
legacy `CONSULT_AGENT_SANDBOX` layer does not re-wrap inherited Jobs.

Confined launches use pinned `@anthropic-ai/sandbox-runtime@0.0.64` to generate
native bubblewrap/Seatbelt artifacts. Consult version-checks, shape-checks, and
transforms those artifacts to remove shared writes, preserve Job-private
writes, authenticate proxy transport, and repair the pinned Linux proxy-socket
mount order. Any version or artifact drift fails closed. Moving to native
backends becomes preferable if this transform expands beyond generated
filesystem/network policy, repeated upstream versions break its shape, or
independent runtime defects require a growing local fork.

Each Job receives a private home/temp environment. A Profile-specific Consult
credential environment variable takes precedence and is translated to the
vendor variable only inside the Job. Otherwise, Consult copies one selected
regular credential file. Ambient vendor variables such as `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` are not selected as Profile credentials. Whole Host
configuration trees are not staged;
Codex `config.toml` and Claude `settings.json` are deliberately absent, so an
explicit model may be needed when those files define Profile behavior.
The Profile process tree can read that credential; the guarantee is
egress-constrained, not credential invisibility.

Private roots are mode 0700 and include an owner marker. Later confined
preflights/launches remove roots older than the Job wall-clock limit plus a
grace period when their owner pid is gone. This bounds credential artifacts
left by SIGKILL/OOM crashes without sweeping concurrent live Jobs.

Confined Session continuity uses a selective Job-scoped archive rather than a
shared Profile home. After confirmed process-tree termination, Consult archives
exactly one bounded, hash-verified Codex or Claude transcript before deleting
the private home. A resume request is bound to both source Job id and Session
id, verifies the archive before creating the new Job, and restores only that
transcript. Confined isolated resume fails closed while Execution Workspace
cwd continuity cannot be proven.

Direct networking is denied. An authenticated Host proxy allows pinned public
port-443 destinations from each Profile's model/auth inventory. `--allow-fetch`
broadens this to arbitrary public TCP/443 while continuing to reject private,
link-local, metadata, and mixed DNS answers. This supports HTTPS clients, but
Consult does not inspect the encrypted application protocol. Consult does not add a credential
broker in this version, so fetch explicitly carries prompt-injection
exfiltration risk.

`--allow-exec` remains unavailable. Execute will not ship merely because model
transport is proxied; it also needs execute-specific resource containment and
repeatable cross-Profile/OS conformance. Wall-clock and persisted-log limits
ship now, while process, CPU, memory, and disk quotas remain residual risks.

## Consequences

- A spawning Host can reason about one portable Job Authority object and use
  `consult doctor` to test the exact default combination before delegation.
- The safe default may reject a Job that could have run with ambient authority;
  the Host must opt into inheritance and accept that loss of boundary.
- Task-specific fetch is efficient but materially broadens the exfiltration
  surface. Documentation and skills must say so.
- Support is earned per Profile/OS/Host-context combination. A standalone
  macOS control does not imply nested Seatbelt works under the Codex Host.
- Process-tree and proxy cleanup are part of the security boundary. If process
  termination cannot be confirmed, Consult retains the launch lease rather
  than tearing down its proxy and Job state underneath a live Profile. That
  intentionally wedges the current Consult process until restart; stale Job
  state is removed by a later owner-aware sweep.
