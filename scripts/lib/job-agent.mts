import crypto from "node:crypto";

import type {
  PermissionOption,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { newSession, promptTurn, startAgent } from "./acp-client.mts";
import type { StartedAgent } from "./acp-client.mts";
import { createFsHandlers } from "./fs-handlers.mts";
import type { FsHandlerMode } from "./fs-handlers.mts";
import { decidePermission } from "./permissions.mts";
import type { PermissionMode } from "./permissions.mts";
import { applySessionControls, openResumedSession } from "./session-controls.mts";
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
  getSessionMode(sessionId: string): string | undefined;
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
  mode?: string;
  sandbox?: string;
  profileRegistryId?: string;
  jobId?: string | null;
  runtime: JobAgentRuntimeHooks;
}

export async function startJobAgent({
  binary,
  args = [],
  env = {},
  cwd,
  mode = "read-only",
  sandbox = "off",
  profileRegistryId,
  jobId = null,
  runtime,
}: StartJobAgentOptions): Promise<StartedAgent> {
  return await startAgent({
    binary,
    args,
    env: {
      ...env,
      // Propagate delegation lineage so a delegated agent cannot escape its
      // ceiling by omitting --parent-job.
      ...(jobId ? { CONSULT_PARENT_JOB: jobId } : {}),
      CONSULT_WORKSPACE: cwd,
    },
    cwd,
    workspaceRoot: cwd,
    mode,
    sandbox,
    profileRegistryId,
    clientHandlers: {
      sessionUpdate: async ({ sessionId, update }) =>
        await runtime.handleSessionUpdate({ sessionId, update }),
      requestPermission: async ({ sessionId, ...request }) => {
        const decision = await decidePermission({
          request,
          mode: (runtime.getSessionMode(sessionId) ?? "read-only") as PermissionMode,
          workspaceRoot: cwd,
        });
        runtime.notePermissionDecision({ sessionId, decision, request });
        return permissionResponse(decision, request.options);
      },
      readTextFile: async (request) => {
        const handlers = createFsHandlers({
          workspaceRoot: cwd,
          mode: (runtime.getSessionMode(request.sessionId) ?? "read-only") as FsHandlerMode,
        });
        return await handlers.readTextFile(request);
      },
      writeTextFile: async (request) => {
        const handlers = createFsHandlers({
          workspaceRoot: cwd,
          mode: (runtime.getSessionMode(request.sessionId) ?? "read-only") as FsHandlerMode,
        });
        return await handlers.writeTextFile(request);
      },
    },
  });
}

export interface AgentTurnContext {
  config: { cwd: string };
  ensureAgent(mode?: string, jobId?: string | null): Promise<StartedAgent>;
  getSession(): string | undefined;
  getSessionState?(): AgentSessionState | undefined;
  setSession(sessionId: string, sessionState?: AgentSessionState | null): void;
  trackSession(sessionId: string, job: BrokerJob, mode: string): void;
  finalizeJob(job: BrokerJob, finalized: { stopReason: string; sessionId: string }): Promise<void>;
  noteTurnSettled(job: BrokerJob): void;
}

export async function runAgentJobTurn(
  params: ConsultRunParams,
  job: BrokerJob,
  ctx: AgentTurnContext,
): Promise<void> {
  const agent = await ctx.ensureAgent(params.mode ?? "read-only", params.jobId);
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
  ctx.trackSession(sessionId, job, params.mode ?? "read-only");
  sessionState = await applySessionControls(agent.connection, {
    sessionId,
    sessionState,
    model: params.model,
    effort: params.effort,
    profile: params.profile,
  });
  ctx.setSession(sessionId, sessionState);

  for await (const event of promptTurn(agent.connection, {
    sessionId,
    prompt: params.prompt,
  })) {
    if (event.type === "stop") {
      if (job.status !== "running") {
        // A job finalized early (policy violation) settles here; clear its
        // pending cancel-ack timer so the broker is not tainted retroactively.
        ctx.noteTurnSettled(job);
        continue;
      }
      // Busy clears in handleRunMessage only after this turn fully settles.
      await ctx.finalizeJob(job, {
        stopReason: event.stopReason,
        sessionId,
      });
    }
  }
}

export interface CodedAgentError extends Error {
  code?: string | number;
}

export function agentErrorMessage(error: CodedAgentError): string {
  if (error.code) {
    return `${error.code}: ${error.message}`;
  }
  return error.message;
}

export function hashRunPayload(params: ConsultRunParams): string {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        prompt: params.prompt,
        profile: params.profile,
        mode: params.mode,
        resume: params.resume ?? null,
        model: params.model ?? null,
        effort: params.effort ?? null,
      }),
    )
    .digest("hex");
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
