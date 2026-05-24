# Consult Glossary

A delegation layer that lets a user start work from one coding environment and delegate it to another over the Agent Client Protocol (ACP).

## Language

**Host**:
The coding environment where the user invokes Consult and from which delegation starts.
_Avoid_: Caller, source agent, frontend

**Host Session**:
A live invocation context inside one Host whose delegated work should share lifecycle and cleanup.
_Avoid_: Claude session id, caller session, window

**Host Identity**:
The Host name and Host Session id supplied with a Consult invocation.
_Avoid_: Caller metadata, source context

**Custom Host**:
A Host name supplied by direct CLI use or an unsupported adapter.
_Avoid_: Unknown host, arbitrary caller

**Consult Core**:
The host-neutral delegation model shared by all ways of invoking Consult.
_Avoid_: Runtime, engine, shared library

**Host Adapter**:
The Host-specific bridge that presents Consult through one Host's native interface and lifecycle.
_Avoid_: Plugin, wrapper, frontend

**Profile**:
A configured ACP backend (e.g. codex, claude, gemini, opencode, copilot) available to Consult regardless of which Host invokes it.
_Avoid_: Backend, agent-config

**Profile Capability**:
A native action or behavior exposed by one Profile that Consult can invoke through a Profile-specific adapter.
_Avoid_: Consult object, universal feature, special sauce

**Broker**:
The Consult-owned ACP-agent daemon that owns backend process communication for one active Job and exits after that Job finalizes.
_Avoid_: Server, runtime (daemon is a synonym used informally in code)

**Session**:
The ACP-side conversation, identified by `sessionId`, held in the broker's memory. Created via `session/new`, reattached via `session/resume` (no-replay) or `session/load` (history replay).
_Avoid_: Thread, conversation, chat

**Prompt turn**:
One `session/prompt` request-response cycle inside a session. Streams `session/update` notifications until a stop reason is reported.
_Avoid_: Turn alone (ambiguous), call, exchange

**Job**:
The plugin-side tracking record for one `delegate` or `review` invocation. Each job maps to exactly one prompt turn against exactly one session.
_Avoid_: Task, run

**Delegation Chain**:
The lineage of Jobs created when delegated work invokes Consult again.
_Avoid_: Recursion, call stack, agent loop

**Chain Id**:
The root Job id shared by all Jobs in one Delegation Chain.
_Avoid_: Root job pointer, lineage id

**Workspace**:
The git repo root where commands are invoked. The scoping unit for state files and brokers.
_Avoid_: Project, repo (in code contexts)

**Registry**:
The static catalog of known ACP backends shipped with the plugin. Each entry records install command, binary name, spawn args. Used by `/consult:setup` to populate the installer menu.
_Avoid_: Catalog, manifest

## Relationships

- A **Host** has 0..N **Host Sessions**.
- A **Host** uses 1 **Host Adapter** to invoke **Consult Core**.
- A **Host Adapter** supplies **Host Identity** to **Consult Core**.
- A **Custom Host** may invoke **Consult Core** without being a supported **Host Adapter**.
- A **Host Session** starts 0..N **Jobs** in a **Workspace**.
- Consult has 0..N configured **Profiles**.
- A **Host** may choose a default **Profile**.
- A **Workspace** may override the default **Profile**.
- A **Job** has 0..1 live **Broker** while it is running.
- A **Broker** hosts 0..N **Sessions** while it is alive.
- A **Session** has 1..N **Prompt turns** over its lifetime.
- A **Job** starts from exactly 1 **Host**, targets exactly 1 **Profile**, is associated with exactly 1 **Session**, and represents exactly 1 **Prompt turn**.
- A **Job** may target a **Profile** for the same product as its **Host**.
- A **Job** may belong to 0..1 **Delegation Chain**.
- A **Delegation Chain** contains 1..N **Jobs**.
- A **Delegation Chain** has exactly 1 **Chain Id**.
- Jobs in a **Delegation Chain** are still first-class **Jobs**.
- Cancelling a parent **Job** cancels active descendant **Jobs** in the same **Delegation Chain**.
- Failure of a child **Job** does not automatically fail its parent **Job**.
- A **Job** result is the output of that exact **Job**, not an automatic rollup of its **Delegation Chain**.
- A **Delegation Chain** stays in one **Workspace** by default.
- A child **Job** in a **Delegation Chain** cannot be more permissive than its parent **Job**.
- A child **Job** may target the same **Profile** as its parent **Job**.
- A **Registry** entry describes one possible **Profile**.
- A **Profile Capability** belongs to one or more **Profiles** and may be unavailable on others.

## Example dialogue

> **Dev:** "When the user runs `/consult:delegate --resume`, what reattaches?"
> **Domain expert:** "The latest finished **Job** for the current **Host Session**, **Profile**, and **Workspace** points to a **Session**. We start a fresh **Broker** and ask the Profile to reopen that **Session** via `session/resume` or `session/load`."

> **Dev:** "If a user starts two background Jobs for codex in the same Host chat, how many Brokers exist?"
> **Domain expert:** "Two while both Jobs are running. Each active **Job** gets its own **Broker**, and each **Broker** exits after its **Job** finalizes."

## Flagged ambiguities

- "Agent" was overloaded between *the environment starting delegation*, *the ACP-speaking backend process*, and *Claude Code's subagent system*. Resolved: **Host** is where delegation starts, **Profile** is the ACP backend being delegated to, and "subagent" refers to the in-Claude proactive forwarder (`agents/delegate.md`).
- The same product can appear as both **Host** and **Profile**, but support for one role does not imply support for the other.
- In a **Delegation Chain**, **Host** means the immediate environment invoking Consult for that Job, not the original root environment.
- **Delegation Chain** inheritance covers Workspace, lineage, and permission ceiling; it does not imply inheriting Profile-specific model, effort, or resume settings.
- Default **Profile** selection order is explicit choice, then Workspace override, then Host default, then global default.
- Direct CLI use has no external **Host Adapter** or natural lifecycle hook. Resolved: treat terminal use as a **Host** with a synthetic **Host Session**.
- "Resume" could mean reattach-without-replay (`session/resume`) or rehydrate-from-storage (`session/load`). We expose user-facing `--resume` and `--resume-job` selectors; Consult starts a fresh **Broker** and picks the ACP method based on Profile capability.
- The `codex` profile's binary is **`codex-acp`** — a separate ACP shim (zed-industries/codex-acp) that wraps the underlying `codex` CLI. Having the `codex` CLI on `PATH` does not satisfy the `codex` profile; the shim must be installed independently. Same pattern for `claude` (shim binary `claude-agent-acp`, distinct from the Claude Code CLI).
