import path from "node:path";

import type { ClientSideConnection } from "@agentclientprotocol/sdk";

import { appendBoundedText, DEFAULT_MAX_FINAL_TEXT_CHARS } from "./bounded-text.mts";
import { cancelPrompt } from "./acp-client.mts";
import { cancelCascadeJobTargets } from "./delegation-chain.mts";
import {
  failedBrokerJobRecord,
  finalizedBrokerJobRecord,
  readWorkspaceJobRecord,
  writeJobRecord as persistJobRecord,
} from "./job-records.mts";
import type { BrokerJobSnapshot, FinalizedJobOutcome } from "./job-records.mts";
import { isInsideWorkspaceSync } from "./path-safety.mts";
import { renderSessionUpdate } from "./session-update-renderer.mts";

import type { ConsultRunParams } from "../consult-broker.mts";

export interface BrokerJobRuntimeConfig {
  cwd: string;
  host: string;
  hostSessionId: string;
  cancelAckTimeoutMs: number;
}

export interface BrokerJobSocketLike {
  once(event: "close", listener: () => void): unknown;
}

export interface BrokerAgentHandle {
  connection: ClientSideConnection;
}

export interface BrokerPermissionDecision {
  allowed: boolean;
}

export interface BrokerPermissionRequest {
  toolCall?: { toolCallId?: string } | null;
}

export interface BrokerSessionUpdateRawInput {
  auto_approved?: unknown;
  autoApproved?: unknown;
  path?: unknown;
  file_path?: unknown;
  [key: string]: unknown;
}

export interface BrokerSessionUpdateToolCall {
  kind?: string | null;
  toolCallId?: string;
  title?: string | null;
  name?: string | null;
  rawInput?: BrokerSessionUpdateRawInput | null;
  [key: string]: unknown;
}

export interface BrokerSessionUpdate extends BrokerSessionUpdateToolCall {
  sessionUpdate?: string;
  content?: { type?: string; text?: string } | null;
  toolCall?: BrokerSessionUpdateToolCall | null;
  locations?: Array<{ path?: string | null } | null | undefined> | null;
  availableCommands?: Array<{ name?: string }> | null;
}

export interface BrokerJobUpdateNotification {
  jobId: string;
  update: BrokerSessionUpdate;
}

export interface BrokerJobFinalized {
  stopReason: string;
  sessionId: string | null;
  errorMessage?: string;
}

export interface BrokerJob {
  jobId: string;
  kind?: string;
  host: string;
  hostSessionId: string;
  profile: string;
  mode?: string;
  prompt: string;
  submittedAt?: string;
  chainId?: string;
  parentJobId?: string | null;
  delegationDepth?: number;
  model?: string | null;
  effort?: string | null;
  resumeSessionId: string | null;
  baseRef?: string;
  status: "running" | "finalized";
  payloadHash: string;
  sessionId: string | null;
  pendingUpdates: BrokerJobUpdateNotification[];
  droppedUpdateCount: number;
  subscribers: Set<BrokerJobSocketLike>;
  finalized: BrokerJobFinalized | null;
  originatorSocket: BrokerJobSocketLike;
  cancelRequested: boolean;
  cancelAckTimer: NodeJS.Timeout | null;
  deniedPermissionSeen: boolean;
  deniedPermissionToolCallIds: Set<string>;
  workspaceRoot: string;
  startedAt: string;
  completedAt: string | null;
  finalText: string;
}

export interface CreateBrokerJobRuntimeOptions {
  config: BrokerJobRuntimeConfig;
  ensureAgent(mode?: string): Promise<BrokerAgentHandle>;
  hashRunPayload(params: ConsultRunParams): string;
  writeNotification(socket: BrokerJobSocketLike, method: string, params: unknown): void;
  onActivity?(): void;
  onTerminal?(job: BrokerJob): void;
  maxFinalTextChars?: number;
}

export interface BrokerJobRuntime {
  readonly tainted: boolean;
  isTainted(): boolean;
  isBusy(): boolean;
  setBusy(value: boolean): void;
  getJob(jobId: string): BrokerJob | undefined;
  createJob(params: ConsultRunParams, originatorSocket: BrokerJobSocketLike): BrokerJob;
  attachJob(job: BrokerJob, targetSocket: BrokerJobSocketLike): void;
  trackSession(sessionId: string, job: BrokerJob, mode: string): void;
  getSessionMode(sessionId: string): string | undefined;
  clearSessions(): void;
  handleSessionUpdate(params: { sessionId: string; update: BrokerSessionUpdate }): Promise<void>;
  notePermissionDecision(params: {
    sessionId: string;
    decision: BrokerPermissionDecision;
    request: BrokerPermissionRequest;
  }): void;
  finalizeJob(job: BrokerJob, finalized: BrokerJobFinalized): Promise<void>;
  failJob(job: BrokerJob, errorMessage: string): Promise<void>;
  cancelJob(job: BrokerJob): Promise<void>;
  cancelJobCascade(job: BrokerJob): string[];
  noteTurnSettled(job: BrokerJob): void;
  handleSocketClosed(socket: BrokerJobSocketLike): void;
  hasRunningJob(): boolean;
  runningJobs(): BrokerJob[];
}

export function createBrokerJobRuntime({
  config,
  ensureAgent,
  hashRunPayload,
  writeNotification,
  onActivity = () => {},
  onTerminal = () => {},
  maxFinalTextChars = DEFAULT_MAX_FINAL_TEXT_CHARS,
}: CreateBrokerJobRuntimeOptions): BrokerJobRuntime {
  const sessionJobs = new Map<string | null, BrokerJob>();
  const sessionModes = new Map<string, string>();
  const activeJobs = new Map<string, BrokerJob>();
  let busy = false;
  let tainted = false;

  return {
    get tainted() {
      return tainted;
    },
    isTainted() {
      return tainted;
    },
    isBusy() {
      return busy;
    },
    setBusy(value) {
      busy = value;
      onActivity();
    },
    getJob(jobId) {
      return activeJobs.get(jobId);
    },
    createJob(params, originatorSocket) {
      const job: BrokerJob = {
        jobId: params.jobId,
        kind: params.kind,
        host: params.host ?? config.host,
        hostSessionId: params.hostSessionId ?? config.hostSessionId,
        profile: params.profile,
        mode: params.mode,
        prompt: params.prompt,
        submittedAt: params.submittedAt,
        chainId: params.chainId,
        parentJobId: params.parentJobId,
        delegationDepth: params.delegationDepth,
        model: params.model,
        effort: params.effort,
        resumeSessionId: params.resume ?? null,
        baseRef: params.baseRef,
        status: "running",
        payloadHash: hashRunPayload(params),
        sessionId: null,
          pendingUpdates: [],
          droppedUpdateCount: 0,
        subscribers: new Set(),
        finalized: null,
        originatorSocket,
        cancelRequested: false,
        cancelAckTimer: null,
        deniedPermissionSeen: false,
        deniedPermissionToolCallIds: new Set(),
        workspaceRoot: config.cwd,
        startedAt: new Date().toISOString(),
        completedAt: null,
        finalText: "",
      };
      activeJobs.set(params.jobId, job);
      onActivity();
      return job;
    },
      attachJob(job, targetSocket) {
        if (job.droppedUpdateCount > 0) {
          writeNotification(targetSocket, "consult/update", {
            jobId: job.jobId,
            update: {
              sessionUpdate: "consult_update_gap",
              droppedUpdateCount: job.droppedUpdateCount,
            },
          });
        }
        for (const update of job.pendingUpdates) {
          writeNotification(targetSocket, "consult/update", update);
        }
      if (job.status === "finalized") {
        writeNotification(targetSocket, "consult/finalized", {
          jobId: job.jobId,
          ...job.finalized,
        });
        return;
      }

      job.subscribers.add(targetSocket);
      targetSocket.once("close", () => job.subscribers.delete(targetSocket));
    },
    trackSession(sessionId, job, mode) {
      job.sessionId = sessionId;
      sessionJobs.set(sessionId, job);
      sessionModes.set(sessionId, mode);
    },
    getSessionMode(sessionId) {
      return sessionModes.get(sessionId);
    },
    clearSessions() {
      sessionJobs.clear();
      sessionModes.clear();
    },
    async handleSessionUpdate({ sessionId, update }) {
      const job = sessionJobs.get(sessionId);
      if (job?.status === "running" && isAutoApprovedPolicyViolation(job, update)) {
        await failJobForPolicyViolation(job, autoApprovedPolicyViolationMessage(job, update) as string);
        return;
      }
      if (job?.status === "running") {
        writeJobUpdate(job, update);
      }
    },
    notePermissionDecision({ sessionId, decision, request }) {
      const job = sessionJobs.get(sessionId);
      if (job && !decision.allowed) {
        job.deniedPermissionSeen = true;
        if (request.toolCall?.toolCallId) {
          job.deniedPermissionToolCallIds.add(request.toolCall.toolCallId);
        }
      }
    },
    async finalizeJob(job, finalized) {
      clearCancelAckTimer(job);
      job.status = "finalized";
      job.finalized = finalized;
      job.completedAt = new Date().toISOString();
      sessionJobs.delete(job.sessionId);
      // ACP sessions outlive prompt turns; keep sessionModes until broker shutdown.
      // Persisted terminal state and finalized notifications are readiness
      // boundaries: observers may immediately submit the next Job.
      busy = false;
      await writeJobRecord(job, finalized);
      // Keep finalized jobs for this daemon lifetime; eviction is deferred for v1.
      notifyFinalized(job, finalized);
      onActivity();
      onTerminal(job);
    },
    async failJob(job, errorMessage) {
      clearCancelAckTimer(job);
      if (job.status === "finalized") {
        return;
      }
      job.status = "finalized";
      job.completedAt = new Date().toISOString();
      job.finalized = {
        stopReason: "failed",
        sessionId: job.sessionId,
        errorMessage,
      };
      sessionJobs.delete(job.sessionId);
      busy = false;
      await writeFailedJobRecord(job);
      notifyFinalized(job, job.finalized);
      onActivity();
      onTerminal(job);
    },
    async cancelJob(job) {
      job.cancelRequested = true;
      if (!job.sessionId) {
        return;
      }
      startCancelAckTimer(job);
      // Reuse the agent that runs this job; a bare ensureAgent() would default to
      // read-only and restart a sandboxed write-mode agent mid-turn.
      const currentAgent = await ensureAgent(job.mode ?? "read-only");
      await cancelPrompt(currentAgent.connection, { sessionId: job.sessionId });
    },
    cancelJobCascade(job) {
      const { descendants, targets } = cancelCascadeJobTargets(job, activeJobs.values());
      for (const target of targets) {
        this.cancelJob(target).catch(() => {});
      }
      return descendants.map((candidate) => candidate.jobId);
    },
    noteTurnSettled(job) {
      clearCancelAckTimer(job);
    },
    handleSocketClosed(socket) {
      for (const job of activeJobs.values()) {
        job.subscribers.delete(socket);
        if (job.originatorSocket === socket && job.status === "running") {
          startCancelAckTimer(job);
          this.cancelJob(job).catch(() => {});
        }
      }
    },
    hasRunningJob() {
      for (const job of activeJobs.values()) {
        if (job.status === "running") {
          return true;
        }
      }
      return false;
    },
    runningJobs() {
      return [...activeJobs.values()].filter((job) => job.status === "running");
    },
  };

  function writeJobUpdate(job: BrokerJob, update: BrokerSessionUpdate) {
    const notification = { jobId: job.jobId, update };
      job.finalText = appendBoundedText(job.finalText, renderSessionUpdate(update), {
        maxChars: maxFinalTextChars,
      });
      job.pendingUpdates.push(notification);
      if (job.pendingUpdates.length > 500) {
        job.pendingUpdates.shift();
        job.droppedUpdateCount += 1;
      }
    for (const subscriber of job.subscribers) {
      writeNotification(subscriber, "consult/update", notification);
    }
  }

  async function failJobForPolicyViolation(job: BrokerJob, errorMessage: string) {
    clearCancelAckTimer(job);
    // Defense in depth: an auto-approved edit update can arrive after the edit already hit disk.
    job.status = "finalized";
    job.completedAt = new Date().toISOString();
    job.finalized = {
      stopReason: "failed",
      sessionId: job.sessionId,
      errorMessage,
    };
    sessionJobs.delete(job.sessionId);
    // Busy stays set until the violated prompt turn settles (or the cancel-ack
    // timer fires), so a second consult/run cannot interleave prompt turns.
    job.cancelRequested = true;
    startCancelAckTimer(job);
    ensureAgent(job.mode ?? "read-only")
      .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId as string }))
      .catch(() => {});
    await writeFailedJobRecord(job);
    notifyFinalized(job, job.finalized);
    onActivity();
    onTerminal(job);
  }

  function startCancelAckTimer(job: BrokerJob) {
    if (job.cancelAckTimer) {
      return;
    }
    job.cancelAckTimer = setTimeout(() => {
      job.cancelAckTimer = null;
      if (job.status === "running") {
        job.status = "finalized";
        job.completedAt = new Date().toISOString();
        job.finalized = {
          stopReason: "failed",
          sessionId: job.sessionId,
          errorMessage: "agent did not acknowledge cancel",
        };
        sessionJobs.delete(job.sessionId);
        writeFailedJobRecord(job).catch(() => {});
        busy = false;
        notifyFinalized(job, job.finalized);
      }
      // The job may already be finalized (policy violation) while its prompt
      // turn is still unsettled; an unacknowledged cancel always taints.
      busy = false;
      tainted = true;
      onActivity();
      onTerminal(job);
    }, config.cancelAckTimeoutMs);
  }

  function clearCancelAckTimer(job: BrokerJob) {
    if (job.cancelAckTimer) {
      clearTimeout(job.cancelAckTimer);
      job.cancelAckTimer = null;
    }
  }

  function notifyFinalized(job: BrokerJob, finalized: BrokerJobFinalized) {
    for (const subscriber of job.subscribers) {
      writeNotification(subscriber, "consult/finalized", {
        jobId: job.jobId,
        ...finalized,
      });
    }
    job.subscribers.clear();
  }

  async function writeJobRecord(job: BrokerJob, finalized: BrokerJobFinalized) {
    const existing = await readExistingJobRecord(job.jobId);
    await persistJobRecord(config.cwd, job.jobId, finalizedBrokerJobRecord(existing, job as BrokerJobSnapshot, finalized as FinalizedJobOutcome));
  }

  async function writeFailedJobRecord(job: BrokerJob) {
    const existing = await readExistingJobRecord(job.jobId);
    await persistJobRecord(config.cwd, job.jobId, failedBrokerJobRecord(existing, job as BrokerJobSnapshot & { finalized: FinalizedJobOutcome }));
  }

  async function readExistingJobRecord(jobId: string) {
    try {
      return await readWorkspaceJobRecord(config.cwd, jobId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }
}

function isAutoApprovedPolicyViolation(job: BrokerJob, update: BrokerSessionUpdate): boolean {
  return autoApprovedPolicyViolationMessage(job, update) !== null;
}

function autoApprovedPolicyViolationMessage(job: BrokerJob, update: BrokerSessionUpdate): string | null {
  const toolCall = update?.toolCall ?? update;
  const rawInput = toolCall?.rawInput ?? update?.rawInput;
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind.toLowerCase() : null;
  const autoApproved = rawInput?.auto_approved === true || rawInput?.autoApproved === true;
  const mode = job.mode ?? "read-only";

  if (mode === "read-only") {
    if (autoApproved) {
      return "policy violation: auto-approved edit update in read-only mode";
    }

    if (kind !== "edit") {
      return null;
    }

    const toolCallId = toolCall.toolCallId ?? update?.toolCallId;
    if (toolCallId) {
      return job.deniedPermissionToolCallIds.has(toolCallId)
        ? null
        : "policy violation: auto-approved edit update in read-only mode";
    }
    return job.deniedPermissionSeen
      ? null
      : "policy violation: auto-approved edit update in read-only mode";
  }

  if (mode !== "write" || kind !== "edit") {
    return null;
  }

  const touchedPath = extractTouchedPath(update, job.workspaceRoot);
  if (touchedPath === null) {
    return null;
  }

  return isTouchedPathInsideWorkspace(touchedPath, job.workspaceRoot)
    ? null
    : "policy violation: auto-approved edit outside workspace";
}

function extractTouchedPath(update: BrokerSessionUpdate, workspaceRoot: string): string | null {
  const paths = [
    update?.locations?.[0]?.path,
    update?.toolCall?.rawInput?.path,
    update?.toolCall?.rawInput?.file_path,
    update?.rawInput?.path,
    update?.rawInput?.file_path,
  ];
  const touchedPath = paths.find((candidate): candidate is string => {
    return typeof candidate === "string" && candidate.length > 0;
  });

  if (!touchedPath) {
    return null;
  }

  if (path.isAbsolute(touchedPath)) {
    return touchedPath;
  }

  return workspaceRoot ? path.resolve(workspaceRoot, touchedPath) : null;
}

function isTouchedPathInsideWorkspace(touchedPath: string, workspaceRoot: string): boolean {
  if (!workspaceRoot) {
    return false;
  }
  try {
    return isInsideWorkspaceSync(touchedPath, workspaceRoot);
  } catch {
    return false;
  }
}
