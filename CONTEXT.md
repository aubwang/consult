# Consult Glossary

Consult is a host-neutral delegation layer. A coding environment starts a
self-contained Job and delegates one prompt turn to a configured ACP Profile.

## Language

**Host**
The coding environment where Consult is invoked and delegation starts. Shipped
Host detection understands terminal, Codex, and opencode; an explicit custom
Host name is also valid.
_Avoid_: caller, source agent, frontend

**Host Session**
A live invocation context inside one Host. It scopes defaults, implicit resume,
lineage metadata, and best-effort lifecycle cleanup.
_Avoid_: thread id, caller session, window

**Host Identity**
The `(host, hostSessionId)` pair resolved for one Consult invocation.
_Avoid_: caller metadata, source context

**Custom Host**
A Host name supplied through CLI flags or Consult environment variables rather
than built-in autodetection.
_Avoid_: unknown Host, unsupported Host

**Consult Core**
The host-neutral implementation of Profiles, Jobs, Brokers, Sessions, state,
permissions, setup, and results behind the `consult` CLI.
_Avoid_: plugin, wrapper, frontend

**Profile**
A configured ACP agent available to Consult regardless of the invoking Host.
The shipped Profile registry contains `codex`, `claude`, and `opencode`.
Generic custom Profile configuration remains possible.
_Avoid_: backend, agent-config

**Profile Capability**
A native action or behavior advertised by one Profile. Consult may use a
verified capability as an optimization while preserving a portable fallback.
_Avoid_: universal feature, special sauce

**Job Authority**
The bounded permission set a Host grants to one Job in addition to its prompt.
Consult may enforce a grant more narrowly but never broaden it implicitly.
_Avoid_: Profile Capability, sandbox flags, agent trust

**Broker**
The Consult-owned, Job-scoped process that owns ACP communication for a
background Job and exits after the Job finalizes. Foreground and isolated
background Jobs may use the same runtime inline instead.
_Avoid_: app server, permanent daemon

**Session**
The Profile-side conversation identified by `sessionId`. A fresh Consult
process can ask the Profile to reopen it with ACP `session/resume` or
`session/load` when advertised.
_Avoid_: native CLI thread, transferred conversation

**Prompt turn**
One `session/prompt` request-response cycle inside a Session. It streams
`session/update` notifications and ends with a stop reason.
_Avoid_: call, exchange

**Job**
The Consult tracking record for exactly one `delegate` or `review` prompt turn.
A Job records request metadata, lifecycle, outcome, artifacts, and lineage.
_Avoid_: task, native session

**Job Result**
The stable, versioned public representation of a Job. Schema version 1 groups
fields under `job`, `outcome`, `artifacts`, and `lineage`; internal Job-record
fields are not automatically exposed.
_Avoid_: raw record dump, rendered log

**Artifact**
A durable file produced around a Job, such as its NDJSON log, isolated-write
patch, or touched-files manifest. Artifact paths belong to the Job Result.
_Avoid_: final answer

**Delegation Chain**
The lineage of Jobs created when delegated work invokes Consult again.
_Avoid_: recursion, call stack, agent loop

**Chain Id**
The root Job id shared by every Job in one Delegation Chain.
_Avoid_: root pointer, lineage id

**Workspace**
The canonical Git repository root where Consult is invoked. It is the identity
and state-scoping unit even when a Job executes in an isolated worktree.
_Avoid_: current directory, temporary checkout

**Execution Workspace**
The directory exposed to a Profile as its cwd. For an in-place Job it is the
Workspace; for an isolated write Job it is a detached worktree seeded from the
Workspace's current tracked and safe untracked state.
_Avoid_: Workspace identity, session transfer

**Isolated write Job**
A write Job whose Execution Workspace is temporary. Consult captures only the
Profile's delta as a patch and touched-files artifact, then removes the
worktree. Its isolation is transactional and distinct from native process
confinement.
_Avoid_: branch checkout, hard sandbox

**Registry**
The static catalog of known Profile installers and launch commands shipped
with Consult. `consult setup` uses it to install and verify Profiles.
_Avoid_: marketplace, plugin manifest

## Relationships and Invariants

- A Host has zero or more Host Sessions.
- Every invocation resolves exactly one Host Identity.
- A Host Session starts zero or more Jobs in a Workspace.
- Consult has zero or more configured Profiles; a Job targets exactly one.
- A Job represents exactly one prompt turn against exactly one Session.
- A Job may have zero or one live Broker while running.
- A Job Result describes that Job only, not an automatic chain rollup.
- Every root Job has a Job Authority granted by its trusted Host.
- New Jobs default to read-only confined Job Authority with fetch and execute
  disabled; any broader grant is explicit.
- Inherited Job Authority means Consult adds no OS boundary and never selects
  inheritance as an implicit fallback from failed confinement.
- A Job may belong to zero or one Delegation Chain.
- A Delegation Chain has exactly one Chain Id and one or more Jobs.
- Cancelling a parent Job cancels active descendants in the same chain.
- Child failure does not automatically fail the parent.
- Linked-child authority ceilings are product policy unless parent identity is
  bound outside child-controlled state; they are not an OS security boundary.
- A child Job may target the same Profile as its parent.
- Profiles and native Host products are independent roles; the same product
  may appear in both without implying shared conversation state.
- Workspace identity, Job state, and lineage remain rooted at the original Git
  repository when an isolated Execution Workspace is used.
- A Profile Capability belongs to one or more Profiles and may be absent from
  others. Portable behavior must not require a proprietary agent server.

## Examples

> **Dev:** “What does `consult delegate --resume` reopen?”
> **Domain expert:** “The latest finalized Job for this Host Session, Profile,
> and Workspace points to an ACP Session. Consult starts fresh transport and
> asks that same Profile to reopen the Session. It does not transfer a native
> conversation to a different Profile.”

> **Dev:** “Where does an isolated write Job edit?”
> **Domain expert:** “The Job remains scoped to the original Workspace, but the
> Profile receives a detached Execution Workspace. Consult stores the
> Profile-only delta as artifacts and leaves the original checkout unchanged.”

> **Dev:** “If two background Jobs run at once, how many Brokers exist?”
> **Domain expert:** “Up to two: Brokers are Job-scoped. An isolated worker may
> instead host its Job runtime inline, but the externally visible Job contract
> is the same.”

## Resolved Ambiguities

- “Agent” was overloaded between the invoking environment and the delegated
  ACP process. Use **Host** and **Profile** respectively.
- Direct CLI use has no plugin or lifecycle adapter. It is the terminal Host
  with a synthetic `default` Host Session unless explicitly overridden.
- “Resume” means reopening a Session within the same Profile through ACP. It
  does not mean cross-CLI native session transfer.
- Review is one Profile-neutral Job kind. A verified native capability may be
  an optimization, not a separate public result contract.
- `codex` launches the separate `codex-acp` shim, not the `codex` executable
  itself. `claude` similarly launches `claude-agent-acp`, which can reuse the
  Claude Code CLI's authentication without making Consult a Claude plugin.
