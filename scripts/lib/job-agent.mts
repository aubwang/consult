import crypto from "node:crypto";

import type {
  PermissionOption,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { newSession, promptTurn, startAgent } from "./acp-client.mts";
import type { AcquireAgentLaunch, StartedAgent } from "./acp-client.mts";
import { createFsHandlers } from "./fs-handlers.mts";
import type { FsHandlerMode } from "./fs-handlers.mts";
import { jobAuthorityFromRecord } from "./job-authority.mts";
import type { JobAuthority, JobAuthorityDiagnostic } from "./job-authority.mts";
import { decidePermission } from "./permissions.mts";
import type { PermissionMode } from "./permissions.mts";
import { normalizeAgentSandbox } from "./process-sandbox.mts";
import { copilotAgentVersionDiagnostic, versionAtLeast } from "./profile-launch-policy.mts";
import { acquireConfinedSandboxRuntimeLaunch } from "./sandbox-runtime-launch.mts";
import { readWorkspaceJobRecord } from "./job-records.mts";
import { validateJobAuthorityRuntimeBoundary } from "./job-authority-preflight.mts";
import {
  applySessionControls,
  knownClaudeModelControl,
  openResumedSession,
} from "./session-controls.mts";
import type { BrokerJob, BrokerSessionUpdate } from "./broker-job-runtime.mts";

import type { ConsultRunParams } from "../consult-broker.mts";

// Shared between the Broker daemon and the inline foreground runner so both
// spawn the ACP agent with identical policy wiring (permissions, fs
// confinement, lineage env) and run prompt turns with identical semantics.

export type AgentSessionState =
  | Awaited<ReturnType<typeof newSession>>
  | Awaited<ReturnType<typeof openResumedSession>>
  | Awaited<ReturnType<typeof applySessionControls>>;

export interface JobAgentRuntimeHooks {
  handleSessionUpdate(params: { sessionId: string; update: BrokerSessionUpdate }): Promise<void>;
  getSessionAuthority(sessionId: string): JobAuthority | undefined;
  notePermissionDecision(params: {
    sessionId: string;
    decision: { allowed: boolean; reason?: string };
    request: { toolCall?: { toolCallId?: string } | null };
  }): void;
}

export interface StartJobAgentOptions {
  binary: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  stateWorkspaceRoot?: string;
  authority: JobAuthority;
  sandbox?: string;
  profileRegistryId?: string;
  /** Codex CLI recorded on the Profile at setup (ADR-0036). */
  codexPath?: string;
  jobId?: string | null;
  resumeSourceJobId?: string | null;
  resumeSessionId?: string | null;
  parentJobId?: string | null;
  model?: string | null;
  onSpawn?: (pid: number) => void | Promise<void>;
  runtime: JobAgentRuntimeHooks;
}

export interface StartJobAgentDeps {
  startAgent?: typeof startAgent;
  acquireConfinedLaunch?: typeof acquireConfinedSandboxRuntimeLaunch;
}

export async function startJobAgent(
  {
    binary,
    args = [],
    env = {},
    cwd,
    stateWorkspaceRoot = cwd,
    authority,
    sandbox = "off",
    profileRegistryId,
    codexPath,
    jobId = null,
    resumeSourceJobId = null,
    resumeSessionId = null,
    parentJobId = null,
    model = null,
    onSpawn,
    runtime,
  }: StartJobAgentOptions,
  deps: StartJobAgentDeps = {},
): Promise<StartedAgent> {
  const canonicalAuthority = canonicalRunAuthority({ authority });
  const parentJob = parentJobId
    ? await readWorkspaceJobRecord(stateWorkspaceRoot, parentJobId)
    : undefined;
  const boundary = validateJobAuthorityRuntimeBoundary({
    authority: canonicalAuthority,
    parentJob,
  });
  if (!boundary.ok) {
    throw authorityDiagnosticError(boundary.diagnostic);
  }
  const sandboxMode =
    canonicalAuthority.confinement === "inherit"
      ? "off"
      : normalizeAgentSandbox(sandbox);
  const acquireLaunch: AcquireAgentLaunch | undefined =
    canonicalAuthority.confinement === "confined"
      ? async (launchOptions) =>
          await (deps.acquireConfinedLaunch ?? acquireConfinedSandboxRuntimeLaunch)({
            ...launchOptions,
            authority: canonicalAuthority,
            stateWorkspaceRoot,
            jobId: jobId ?? undefined,
            resumeSourceJobId,
            resumeSessionId,
          })
      : undefined;
  return await (deps.startAgent ?? startAgent)({
    binary,
    args,
    env: {
      ...env,
      // Propagate delegation lineage so a delegated agent cannot escape its
      // ceiling by omitting --parent-job.
      ...(jobId ? { CONSULT_PARENT_JOB: jobId } : {}),
      CONSULT_WORKSPACE: stateWorkspaceRoot,
    },
    cwd,
    workspaceRoot: cwd,
    mode: canonicalAuthority.mode,
    sandbox: sandboxMode,
    profileRegistryId,
    codexPath,
    requestedModel:
      profileRegistryId === "claude" && model
        ? knownClaudeModelControl(model) ?? undefined
        : undefined,
    onSpawn,
    clientHandlers: {
      sessionUpdate: async ({ sessionId, update }) =>
        await runtime.handleSessionUpdate({ sessionId, update }),
      requestPermission: async ({ sessionId, ...request }) => {
        const sessionAuthority = runtime.getSessionAuthority(sessionId) ?? LEGACY_SAFE_AUTHORITY;
        const decision = await decidePermission({
          request,
          mode: sessionAuthority.mode as PermissionMode,
          workspaceRoot: cwd,
          // Execute remains unavailable in decidePermission until the runtime
          // provides proxy-confined model transport.
          allowFetch: sessionAuthority.allowFetch,
          allowExecute: sessionAuthority.allowExecute,
          sandbox: sandboxMode,
        });
        runtime.notePermissionDecision({ sessionId, decision, request });
        return permissionResponse(decision, request.options);
      },
      readTextFile: async (request) => {
        const sessionAuthority =
          runtime.getSessionAuthority(request.sessionId) ?? LEGACY_SAFE_AUTHORITY;
        const handlers = createFsHandlers({
          workspaceRoot: cwd,
          mode: sessionAuthority.mode as FsHandlerMode,
        });
        return await handlers.readTextFile(request);
      },
      writeTextFile: async (request) => {
        const sessionAuthority =
          runtime.getSessionAuthority(request.sessionId) ?? LEGACY_SAFE_AUTHORITY;
        const handlers = createFsHandlers({
          workspaceRoot: cwd,
          mode: sessionAuthority.mode as FsHandlerMode,
        });
        return await handlers.writeTextFile(request);
      },
    },
  }, acquireLaunch ? { acquireLaunch } : {});
}

export interface AgentTurnContext {
  config: { cwd: string; profileRegistryId?: string };
  ensureAgent(
    authority: JobAuthority,
    jobId?: string | null,
    resumeSourceJobId?: string | null,
    resumeSessionId?: string | null,
    parentJobId?: string | null,
    model?: string | null,
  ): Promise<StartedAgent>;
  getSession(): string | undefined;
  getSessionState?(): AgentSessionState | undefined;
  setSession(sessionId: string, sessionState?: AgentSessionState | null): void;
  trackSession(sessionId: string, job: BrokerJob): void;
  finalizeJob(job: BrokerJob, finalized: { stopReason: string; sessionId: string }): Promise<void>;
  noteTurnSettled(job: BrokerJob): void;
}

export async function runAgentJobTurn(
  params: ConsultRunParams,
  job: BrokerJob,
  ctx: AgentTurnContext,
): Promise<void> {
  const canonicalParams = canonicalizeRunParams(params);
  const agent = await ctx.ensureAgent(
    canonicalParams.authority,
    canonicalParams.jobId,
    canonicalParams.resumeJobId,
    canonicalParams.resume,
    canonicalParams.parentJobId,
    canonicalParams.model,
  );
  if (job.status !== "running") {
    return;
  }
  const versionDiagnostic = copilotAgentVersionDiagnostic(
    ctx.config.profileRegistryId ?? params.profile,
    agent.capabilities,
  );
  if (versionDiagnostic !== null) {
    throw copilotVersionError(versionDiagnostic);
  }
  let sessionId: string | undefined;
  let sessionState: AgentSessionState | null = null;
  if (job.resumeSessionId) {
    sessionState = await openResumedSession(agent.connection, agent.capabilities, {
      sessionId: job.resumeSessionId,
      cwd: ctx.config.cwd,
    });
    sessionId = (sessionState as { sessionId?: string }).sessionId ?? job.resumeSessionId;
    ctx.setSession(sessionId, sessionState);
  } else {
    sessionId = ctx.getSession();
    sessionState = ctx.getSessionState?.() ?? null;
  }
  if (!sessionId) {
    sessionState = await newSession(agent.connection, {
      cwd: ctx.config.cwd,
    });
    sessionId = (sessionState as { sessionId: string }).sessionId;
    ctx.setSession(sessionId, sessionState);
  }
  if (job.status !== "running") {
    return;
  }
  ctx.trackSession(sessionId, job);
  sessionState = await applySessionControls(agent.connection, {
    sessionId,
    sessionState,
    model: params.model,
    effort: params.effort,
    profile: params.profile,
  });
  ctx.setSession(sessionId, sessionState);

  if (job.status !== "running") {
    return;
  }
  if (job.cancelRequested) {
    // A cancel raced session setup; no prompt is in flight for the agent to
    // acknowledge, so finalize as cancelled instead of prompting.
    await ctx.finalizeJob(job, { stopReason: "cancelled", sessionId });
    return;
  }

  let vulnerableClaudeAsyncSubagentStarted = false;
  const copilotErrorMasquerade = reportsModelErrorsAsMessages(agent.capabilities);
  const copilotErrorTracker = copilotErrorMasquerade ? createCopilotErrorTracker() : null;

  for await (const event of promptTurn(agent.connection, {
    sessionId,
    prompt: params.prompt,
  })) {
    if (
      event.type === "update" &&
      isAsyncClaudeSubagentLaunch(event.update) &&
      usesVulnerableClaudeAsyncFinalization(params.profile, agent.capabilities)
    ) {
      vulnerableClaudeAsyncSubagentStarted = true;
    }
    if (event.type === "update" && copilotErrorTracker) {
      const chunkText = agentMessageChunkText(event.update);
      if (chunkText !== null) {
        copilotErrorTracker.observe(chunkText);
      }
    }
    if (event.type === "stop") {
      if (job.status !== "running") {
        // A job finalized early (policy violation) settles here; clear its
        // pending cancel-ack timer so the broker is not tainted retroactively.
        ctx.noteTurnSettled(job);
        continue;
      }
      if (vulnerableClaudeAsyncSubagentStarted) {
        throw claudeAsyncFinalizationError(agent.capabilities);
      }
      if (event.stopReason === "end_turn" && copilotErrorTracker?.pending() != null) {
        throw copilotModelErrorTurnError(copilotErrorTracker.pending()!);
      }
      // Busy clears in handleRunMessage only after this turn fully settles.
      await ctx.finalizeJob(job, {
        stopReason: event.stopReason,
        sessionId,
      });
    }
  }
}

const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ASYNC_FINALIZATION_MIN_VERSION = "0.59.0";

// claude-agent-acp <=0.58.1 could resolve session/prompt while an async Agent
// still ran, so Consult would persist interim text and dispose the Job process.
// Upstream 0.59.0 owns the complete task/follow-up lifecycle; this guard only
// prevents older maintained adapters from reporting a false successful Result.
function isAsyncClaudeSubagentLaunch(update: unknown): boolean {
  if (!isRecord(update)) return false;
  const meta = isRecord(update._meta) ? update._meta : null;
  const claudeCode = meta && isRecord(meta.claudeCode) ? meta.claudeCode : null;
  if (claudeCode?.toolName !== "Agent" && claudeCode?.toolName !== "Task") return false;
  const rawInput = isRecord(update.rawInput) ? update.rawInput : null;
  const toolResponse = claudeCode && isRecord(claudeCode.toolResponse)
    ? claudeCode.toolResponse
    : null;
  return rawInput?.run_in_background === true || toolResponse?.isAsync === true;
}

function usesVulnerableClaudeAsyncFinalization(
  profile: string,
  capabilities: unknown,
): boolean {
  if (profile !== "claude" || !isRecord(capabilities)) return false;
  const agentInfo = isRecord(capabilities.agentInfo) ? capabilities.agentInfo : null;
  if (agentInfo?.name !== CLAUDE_AGENT_ACP_PACKAGE) return false;
  return typeof agentInfo.version !== "string" ||
    !versionAtLeast(agentInfo.version, CLAUDE_ASYNC_FINALIZATION_MIN_VERSION);
}

function copilotVersionError(diagnostic: string): CodedAgentError {
  const error = new Error(diagnostic) as CodedAgentError;
  error.code = "COPILOT_VERSION_UNSUPPORTED";
  return error;
}

function claudeAsyncFinalizationError(capabilities: unknown): CodedAgentError {
  const agentInfo = isRecord(capabilities) && isRecord(capabilities.agentInfo)
    ? capabilities.agentInfo
    : null;
  const version = typeof agentInfo?.version === "string" ? agentInfo.version : "unknown";
  const error = new Error(
    `${CLAUDE_AGENT_ACP_PACKAGE} ${version} returned before its background subagent finalized; ` +
      `update with npm install -g ${CLAUDE_AGENT_ACP_PACKAGE}@^${CLAUDE_ASYNC_FINALIZATION_MIN_VERSION} and retry`,
  ) as CodedAgentError;
  error.code = "CLAUDE_ASYNC_FINALIZATION_UNSUPPORTED";
  return error;
}

// Copilot CLI maps model/provider failures to plain agent_message_chunk text
// ("Error: ...") and still resolves session/prompt with end_turn, so a dead
// endpoint or revoked login would otherwise persist as a successful Job.
// Keyed on the agent-reported identity, not the Profile name, so aliased or
// custom Profiles that launch Copilot are covered too. Chunk boundaries are
// arbitrary, so the turn's agent text is assembled (bounded to a tail) and
// matched against known provider-error signatures near the end of the turn;
// ordinary answers that merely mention "Error:" do not match. The signature
// list is a stopgap until Copilot reports structured errors over ACP.
// Classification is match-completion over chunks: a rolling window of recent
// agent text spans chunk boundaries, and a pending terminal error is marked
// when a chunk COMPLETES a recognized signature — whether the notice arrived
// whole (observed live: the CLI injects each notice as one session/update
// notification) or split across notifications ("Err" + "or: Failed ...").
// A substantive chunk that completes no signature is answer text and clears
// the pending error, so a recovered answer — glued, indented, or on its own
// line — finalizes as end_turn; whitespace-only chunks are inert. Known
// residual until Copilot reports structured errors: a notice whose
// CONTINUATION (not its head) streams in later substantive chunks would
// clear the pending error; that upstream behavior has not been observed.
const COPILOT_ERROR_CAPTURE_CHARS = 2000;
const COPILOT_ERROR_RECENT_CHARS = 512;
const COPILOT_MODEL_ERROR_SIGNATURE =
  /Error: (?:Failed to get response from the AI model|Could not connect to [^\n]{0,120}provider)/gu;

function createCopilotErrorTracker(): {
  observe(chunkText: string): void;
  pending(): string | null;
} {
  let recentText = "";
  let pendingError: string | null = null;
  return {
    observe(chunkText) {
      const appendedStart = recentText.length;
      const candidate = recentText + chunkText;
      if (chunkText.trim() !== "") {
        let completed: string | null = null;
        COPILOT_MODEL_ERROR_SIGNATURE.lastIndex = 0;
        for (
          let match = COPILOT_MODEL_ERROR_SIGNATURE.exec(candidate);
          match !== null;
          match = COPILOT_MODEL_ERROR_SIGNATURE.exec(candidate)
        ) {
          if (match.index + match[0].length > appendedStart) {
            completed = candidate.slice(match.index, match.index + COPILOT_ERROR_CAPTURE_CHARS);
          }
        }
        pendingError = completed;
      }
      recentText = candidate.slice(-COPILOT_ERROR_RECENT_CHARS);
    },
    pending() {
      return pendingError;
    },
  };
}

function reportsModelErrorsAsMessages(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) return false;
  const agentInfo = isRecord(capabilities.agentInfo) ? capabilities.agentInfo : null;
  return agentInfo?.name === "Copilot";
}

function agentMessageChunkText(update: unknown): string | null {
  if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk") return null;
  const content = isRecord(update.content) ? update.content : null;
  return content?.type === "text" && typeof content.text === "string" ? content.text : null;
}

function copilotModelErrorTurnError(errorText: string): CodedAgentError {
  const preview = errorText.trim().replace(/\s+/gu, " ").slice(0, 300);
  const error = new Error(
    `Copilot reported a model error instead of completing the turn: ${preview} ` +
      `— verify the Copilot login (run copilot login, or set COPILOT_GITHUB_TOKEN) ` +
      `or the COPILOT_PROVIDER_* endpoint, then retry`,
  ) as CodedAgentError;
  error.code = "COPILOT_MODEL_ERROR";
  return error;
}

export interface CodedAgentError extends Error {
  code?: string | number;
}

export interface CanonicalConsultRunParams extends ConsultRunParams {
  authority: JobAuthority;
  mode: JobAuthority["mode"];
  allowExecute: boolean;
}

/**
 * Canonicalize protocol and persisted Job inputs at the shared launch seam.
 * Missing authority is the only legacy case: it projects to explicit ambient
 * inheritance. Once authority exists, flat compatibility fields may be absent
 * but may never disagree with it.
 */
export function canonicalizeRunParams(params: ConsultRunParams): CanonicalConsultRunParams {
  const authority = canonicalRunAuthority(params);
  return {
    ...params,
    authority,
    mode: authority.mode,
    allowExecute: authority.allowExecute,
  };
}

export function canonicalRunAuthority(record: unknown): JobAuthority {
  const result = jobAuthorityFromRecord(record);
  if (!result.ok) {
    throw authorityDiagnosticError(result.diagnostic);
  }
  const authority = result.authority;
  if (isRecord(record) && record.authority === undefined && authority.allowExecute) {
    throw authorityDiagnosticError({
      code: "AUTHORITY_EXECUTE_UNAVAILABLE",
      message: "legacy execute authority is unavailable without canonical confined authority",
      remediation: "Recreate the Job without execute authority.",
    });
  }
  if (isRecord(record) && record.authority !== undefined) {
    if (record.mode !== undefined && record.mode !== authority.mode) {
      throw authorityMismatchError("mode");
    }
    if (
      record.allowExecute !== undefined &&
      record.allowExecute !== authority.allowExecute
    ) {
      throw authorityMismatchError("allowExecute");
    }
  }
  return authority;
}

export function agentErrorMessage(error: CodedAgentError): string {
  if (error.code) {
    return `${error.code}: ${error.message}`;
  }
  return error.message;
}

export function hashRunPayload(
  params: ConsultRunParams & { authority?: unknown },
): string {
  const authority = runPayloadAuthority(params);
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        prompt: params.prompt,
        profile: params.profile,
        authority,
        resume: params.resume ?? null,
        resumeJobId: params.resumeJobId ?? null,
        model: params.model ?? null,
        effort: params.effort ?? null,
      }),
    )
    .digest("hex");
}

function runPayloadAuthority(
  params: ConsultRunParams & { authority?: unknown },
): JobAuthority {
  return canonicalRunAuthority(params);
}

const LEGACY_SAFE_AUTHORITY: JobAuthority = Object.freeze({
  schemaVersion: 1,
  mode: "read-only",
  confinement: "inherit",
  allowFetch: false,
  allowExecute: false,
});

function authorityMismatchError(field: "mode" | "allowExecute"): CodedAgentError {
  return authorityDiagnosticError({
    code: "AUTHORITY_MISMATCH",
    message: `Job Authority does not match compatibility field '${field}'`,
    remediation: "Retry the Job without changing its authority payload.",
    details: { field },
  });
}

function authorityDiagnosticError(diagnostic: JobAuthorityDiagnostic): CodedAgentError {
  const error = new Error(diagnostic.message) as CodedAgentError & {
    diagnostic: JobAuthorityDiagnostic;
  };
  error.code = diagnostic.code;
  error.diagnostic = diagnostic;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

export function permissionResponse(
  decision: { allowed: boolean; reason?: string },
  options: PermissionOption[] | undefined,
): RequestPermissionResponse {
  if (decision.allowed) {
    return {
      outcome: {
        outcome: "selected",
        optionId: optionIdFor(options, "allow") ?? "allow",
      },
    };
  }

  return {
    _meta: {
      reason: decision.reason,
    },
    outcome: {
      outcome: "selected",
      optionId: optionIdFor(options, "reject") ?? "reject",
    },
  };
}

function optionIdFor(options: PermissionOption[] | undefined, action: string): string | undefined {
  const prefix = action === "allow" ? "allow" : "reject";
  return options?.find((option) => option.kind?.startsWith(prefix))?.optionId;
}
