import path from "node:path";

import type { ClientSideConnection } from "@agentclientprotocol/sdk";

import { appendBoundedText, DEFAULT_MAX_FINAL_TEXT_CHARS } from "./bounded-text.mts";
import { cancelPrompt } from "./acp-client.mts";
import { cancelCascadeJobTargets } from "./delegation-chain.mts";
import {
  failedBrokerJobRecord,
  finalizedBrokerJobRecord,
  readWorkspaceJobRecord,
  writeJobRecord as defaultPersistJobRecord,
} from "./job-records.mts";
import type { BrokerJobSnapshot, FinalizedJobOutcome } from "./job-records.mts";
import { isInsideWorkspaceSync } from "./path-safety.mts";
import { extractAgentMessageText } from "./session-update-renderer.mts";
import type { JobAuthority } from "./job-authority.mts";
import { canonicalizeRunParams } from "./job-agent.mts";
import {
  DEFAULT_JOB_LOG_LIMIT_BYTES,
  DEFAULT_JOB_WALL_CLOCK_LIMIT_MS,
  JOB_LOG_LIMIT_EXCEEDED,
  JOB_WALL_CLOCK_LIMIT_EXCEEDED,
  jobLimitErrorMessage,
  jobLogLineBytes,
} from "./job-reliability.mts";

import type { ConsultRunParams } from "../consult-broker.mts";

export interface BrokerJobRuntimeConfig {
  /** Profile cwd and permission-confinement root. */
  cwd: string;
  /** Optional original Workspace root used for persisted Job state. */
  stateWorkspaceRoot?: string;
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
  sessionStateArchived?: boolean;
}

export interface BrokerJob {
  jobId: string;
  kind?: string;
  host: string;
  hostSessionId: string;
  profile: string;
  authority: JobAuthority;
  mode?: string;
  allowExecute: boolean;
  prompt: string;
  submittedAt?: string;
  chainId?: string;
  parentJobId?: string | null;
  delegationDepth?: number;
  model?: string | null;
  effort?: string | null;
  resumeSessionId: string | null;
  resumeJobId: string | null;
  sessionStateArchived: boolean;
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
  awaitingViolatedTurn: boolean;
  cancelAckTimer: NodeJS.Timeout | null;
  wallClockTimer: NodeJS.Timeout | null;
  persistedLogBytes: number;
  terminalLogReserveBytes: number;
  deniedPermissionSeen: boolean;
  deniedPermissionToolCallIds: Set<string>;
  workspaceRoot: string;
  startedAt: string;
  completedAt: string | null;
  finalText: string;
}

export interface CreateBrokerJobRuntimeOptions {
  config: BrokerJobRuntimeConfig;
  ensureAgent(authority: JobAuthority): Promise<BrokerAgentHandle>;
  hashRunPayload(params: ConsultRunParams): string;
  writeNotification(socket: BrokerJobSocketLike, method: string, params: unknown): void;
  persistJobRecord?(workspaceRoot: string, jobId: string, record: Record<string, unknown>): Promise<void>;
  beforeTerminal?(job: BrokerJob): Promise<void>;
  onActivity?(): void;
  onTerminal?(job: BrokerJob): void;
  maxFinalTextChars?: number;
  maxWallClockMs?: number;
  maxPersistedLogBytes?: number;
  scheduleWallClock?(handler: () => void, milliseconds: number): NodeJS.Timeout;
  clearWallClock?(timer: NodeJS.Timeout): void;
}

export interface BrokerJobRuntime {
  readonly tainted: boolean;
  isTainted(): boolean;
  isBusy(): boolean;
  setBusy(value: boolean): void;
  getJob(jobId: string): BrokerJob | undefined;
  createJob(params: ConsultRunParams, originatorSocket: BrokerJobSocketLike): BrokerJob;
  attachJob(job: BrokerJob, targetSocket: BrokerJobSocketLike): void;
  trackSession(sessionId: string, job: BrokerJob): void;
  getSessionAuthority(sessionId: string): JobAuthority | undefined;
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
  persistJobRecord = defaultPersistJobRecord,
  beforeTerminal,
  onActivity = () => {},
  onTerminal = () => {},
  maxFinalTextChars = DEFAULT_MAX_FINAL_TEXT_CHARS,
  maxWallClockMs = DEFAULT_JOB_WALL_CLOCK_LIMIT_MS,
  maxPersistedLogBytes = DEFAULT_JOB_LOG_LIMIT_BYTES,
  scheduleWallClock = defaultScheduleWallClock,
  clearWallClock = defaultClearWallClock,
}: CreateBrokerJobRuntimeOptions): BrokerJobRuntime {
  assertPositiveLimit("maxWallClockMs", maxWallClockMs);
  assertPositiveLimit("maxPersistedLogBytes", maxPersistedLogBytes);
  const stateWorkspaceRoot = config.stateWorkspaceRoot ?? config.cwd;
  const sessionJobs = new Map<string | null, BrokerJob>();
  const activeJobs = new Map<string, BrokerJob>();
  let busy = false;
  let tainted = false;
  const preparesTerminalBoundary = beforeTerminal !== undefined;

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
      const canonicalParams = canonicalizeRunParams(params);
      const job: BrokerJob = {
        jobId: canonicalParams.jobId,
        kind: canonicalParams.kind,
        host: canonicalParams.host ?? config.host,
        hostSessionId: canonicalParams.hostSessionId ?? config.hostSessionId,
        profile: canonicalParams.profile,
        authority: canonicalParams.authority,
        mode: canonicalParams.authority.mode,
        allowExecute: canonicalParams.authority.allowExecute,
        prompt: canonicalParams.prompt,
        submittedAt: canonicalParams.submittedAt,
        chainId: canonicalParams.chainId,
        parentJobId: canonicalParams.parentJobId,
        delegationDepth: canonicalParams.delegationDepth,
        model: canonicalParams.model,
        effort: canonicalParams.effort,
        resumeSessionId: canonicalParams.resume ?? null,
        resumeJobId: canonicalParams.resumeJobId ?? null,
        sessionStateArchived: false,
        baseRef: canonicalParams.baseRef,
        status: "running",
        payloadHash: hashRunPayload(canonicalParams),
        sessionId: null,
          pendingUpdates: [],
          droppedUpdateCount: 0,
        subscribers: new Set(),
        finalized: null,
        originatorSocket,
        cancelRequested: false,
        awaitingViolatedTurn: false,
        cancelAckTimer: null,
        wallClockTimer: null,
        persistedLogBytes: 0,
        terminalLogReserveBytes: 0,
        deniedPermissionSeen: false,
        deniedPermissionToolCallIds: new Set(),
        workspaceRoot: config.cwd,
        startedAt: new Date().toISOString(),
        completedAt: null,
        finalText: "",
      };
      job.terminalLogReserveBytes = jobLogLineBytes(
        "consult/finalized",
        { jobId: job.jobId, ...logLimitFinalized() },
      );
      if (job.terminalLogReserveBytes > maxPersistedLogBytes) {
        throw new Error(
          `maxPersistedLogBytes is too small for the terminal Job limit diagnostic`,
        );
      }
      activeJobs.set(canonicalParams.jobId, job);
      job.wallClockTimer = scheduleWallClock(() => {
        void failJobForReliabilityLimit(
          job,
          jobLimitErrorMessage(JOB_WALL_CLOCK_LIMIT_EXCEEDED, maxWallClockMs),
        );
      }, maxWallClockMs);
      job.wallClockTimer.unref?.();
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
      if (job.status === "finalized" && job.finalized) {
        writeNotification(targetSocket, "consult/finalized", {
          jobId: job.jobId,
          ...job.finalized,
        });
        return;
      }

      job.subscribers.add(targetSocket);
      targetSocket.once("close", () => job.subscribers.delete(targetSocket));
    },
    trackSession(sessionId, job) {
      job.sessionId = sessionId;
      sessionJobs.set(sessionId, job);
    },
    getSessionAuthority(sessionId) {
      return sessionJobs.get(sessionId)?.authority;
    },
    clearSessions() {
      sessionJobs.clear();
    },
    async handleSessionUpdate({ sessionId, update }) {
      const job = sessionJobs.get(sessionId);
      if (job?.status === "running" && isAutoApprovedPolicyViolation(job, update)) {
        await failJobForPolicyViolation(job, autoApprovedPolicyViolationMessage(job, update) as string);
        return;
      }
      if (job?.status === "running") {
        const notification = { jobId: job.jobId, update };
        const updateBytes = jobLogLineBytes("consult/update", notification);
        if (
          job.persistedLogBytes + updateBytes + job.terminalLogReserveBytes >
          maxPersistedLogBytes
        ) {
          await failJobForReliabilityLimit(
            job,
            jobLimitErrorMessage(JOB_LOG_LIMIT_EXCEEDED, maxPersistedLogBytes),
          );
          return;
        }
        job.persistedLogBytes += updateBytes;
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
      clearWallClockTimer(job);
      if (job.status === "finalized") {
        return;
      }
      job.status = "finalized";
      const preparedFinalized = await prepareTerminalOutcome(job, finalized);
      job.finalized = boundedFinalized(job, preparedFinalized);
      job.completedAt = new Date().toISOString();
      sessionJobs.delete(job.sessionId);
      // ACP sessions outlive prompt turns; keep sessionModes until broker shutdown.
      // Persisted terminal state and finalized notifications are readiness
      // boundaries: observers may immediately submit the next Job.
      busy = false;
      await writeJobRecord(job, job.finalized).catch((error) => {
        job.finalized = boundedFinalized(job, terminalWriteFailure(job, error));
      });
      // Keep finalized jobs for this daemon lifetime; eviction is deferred for v1.
      notifyFinalized(job, job.finalized);
      onActivity();
      onTerminal(job);
    },
    async failJob(job, errorMessage) {
      clearCancelAckTimer(job);
      clearWallClockTimer(job);
      if (job.status === "finalized") {
        return;
      }
      job.status = "finalized";
      const preparedFinalized = await prepareTerminalOutcome(job, {
        stopReason: "failed",
        sessionId: job.sessionId,
        errorMessage,
      });
      job.completedAt = new Date().toISOString();
      job.finalized = boundedFinalized(job, preparedFinalized);
      sessionJobs.delete(job.sessionId);
      busy = false;
      await writeFailedJobRecord(job).catch((error) => {
        job.finalized = boundedFinalized(job, terminalWriteFailure(job, error));
      });
      notifyFinalized(job, job.finalized);
      onActivity();
      onTerminal(job);
    },
    async cancelJob(job) {
      job.cancelRequested = true;
      if (!job.sessionId) {
        await this.finalizeJob(job, {
          stopReason: "cancelled",
          sessionId: null,
        });
        return;
      }
      startCancelAckTimer(job);
      // Reuse the agent that runs this job; a bare ensureAgent() would default to
      // read-only and restart a sandboxed write-mode agent mid-turn.
      const currentAgent = await ensureAgent(job.authority);
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
      job.awaitingViolatedTurn = false;
      clearCancelAckTimer(job);
      clearWallClockTimer(job);
    },
    handleSocketClosed(socket) {
      for (const job of activeJobs.values()) {
        job.subscribers.delete(socket);
        if (job.originatorSocket === socket && job.status === "running") {
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

  async function prepareTerminalOutcome(
    job: BrokerJob,
    outcome: BrokerJobFinalized,
  ): Promise<BrokerJobFinalized> {
    if (!beforeTerminal) {
      return outcome;
    }
    try {
      await beforeTerminal(job);
      return {
        ...outcome,
        ...(job.sessionStateArchived ? { sessionStateArchived: true } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      const cleanupMessage = message.startsWith("SESSION_STATE_ARCHIVE_FAILED:")
        ? message
        : `PROFILE_CLEANUP_UNCONFIRMED: ${message}`;
      return {
        stopReason: "failed",
        sessionId: outcome.sessionId,
        errorMessage: outcome.errorMessage
          ? `${outcome.errorMessage}; ${cleanupMessage}`
          : cleanupMessage,
        ...(job.sessionStateArchived ? { sessionStateArchived: true } : {}),
      };
    }
  }

  function writeJobUpdate(job: BrokerJob, update: BrokerSessionUpdate) {
    const notification = { jobId: job.jobId, update };
    job.finalText = appendBoundedText(job.finalText, extractAgentMessageText(update), {
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
    clearWallClockTimer(job);
    // Defense in depth: an auto-approved edit update can arrive after the edit already hit disk.
    job.status = "finalized";
    job.cancelRequested = true;
    if (preparesTerminalBoundary && job.sessionId) {
      await ensureAgent(job.authority)
        .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId as string }))
        .catch(() => {});
    }
    const preparedFinalized = await prepareTerminalOutcome(job, {
      stopReason: "failed",
      sessionId: job.sessionId,
      errorMessage,
    });
    job.completedAt = new Date().toISOString();
    job.finalized = boundedFinalized(job, preparedFinalized);
    sessionJobs.delete(job.sessionId);
    // Busy stays set until the violated prompt turn settles (or the cancel-ack
    // timer fires), so a second consult/run cannot interleave prompt turns.
    if (preparesTerminalBoundary) {
      busy = false;
    } else {
      job.awaitingViolatedTurn = true;
      startCancelAckTimer(job);
      ensureAgent(job.authority)
        .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId as string }))
        .catch(() => {});
    }
    await writeFailedJobRecord(job);
    notifyFinalized(job, job.finalized);
    onActivity();
    onTerminal(job);
  }

  async function failJobForReliabilityLimit(job: BrokerJob, errorMessage: string) {
    if (job.status !== "running") {
      return;
    }
    clearCancelAckTimer(job);
    clearWallClockTimer(job);
    job.status = "finalized";
    job.cancelRequested = true;
    if (preparesTerminalBoundary && job.sessionId) {
      await ensureAgent(job.authority)
        .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId as string }))
        .catch(() => {});
    }
    const preparedFinalized = await prepareTerminalOutcome(job, {
      stopReason: "failed",
      sessionId: null,
      errorMessage,
    });
    job.completedAt = new Date().toISOString();
    job.finalized = boundedFinalized(job, preparedFinalized);
    sessionJobs.delete(job.sessionId);
    if (job.sessionId && !preparesTerminalBoundary) {
      job.awaitingViolatedTurn = true;
      startCancelAckTimer(job);
      ensureAgent(job.authority)
        .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId as string }))
        .catch(() => {});
    }
    if (preparesTerminalBoundary) {
      busy = false;
    }
    // The subscriber persists the same terminal outcome after receiving the
    // notification. Do not suppress cleanup/finalization if this first write
    // fails because a full disk is itself a likely log-limit symptom.
    await writeFailedJobRecord(job).catch(() => {});
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
      void finalizeUnacknowledgedCancel(job);
    }, config.cancelAckTimeoutMs);
  }

  async function finalizeUnacknowledgedCancel(job: BrokerJob): Promise<void> {
    if (job.status !== "running") {
      if (!job.awaitingViolatedTurn) {
        return;
      }
      // A violated turn never settled: release the broker it still holds and
      // taint, matching the failed record its finalization already wrote.
      job.awaitingViolatedTurn = false;
      busy = false;
      tainted = true;
      onActivity();
      onTerminal(job);
      return;
    }
    clearWallClockTimer(job);
    job.status = "finalized";
    const preparedFinalized = await prepareTerminalOutcome(job, {
      stopReason: "failed",
      sessionId: job.sessionId,
      errorMessage: "agent did not acknowledge cancel",
    });
    job.completedAt = new Date().toISOString();
    job.finalized = boundedFinalized(job, preparedFinalized);
    sessionJobs.delete(job.sessionId);
    await writeFailedJobRecord(job).catch(() => {});
    busy = false;
    notifyFinalized(job, job.finalized);
    tainted = true;
    onActivity();
    onTerminal(job);
  }

  function clearCancelAckTimer(job: BrokerJob) {
    if (job.cancelAckTimer) {
      clearTimeout(job.cancelAckTimer);
      job.cancelAckTimer = null;
    }
  }

  function clearWallClockTimer(job: BrokerJob) {
    if (job.wallClockTimer) {
      clearWallClock(job.wallClockTimer);
      job.wallClockTimer = null;
    }
  }

  function boundedFinalized(
    job: BrokerJob,
    finalized: BrokerJobFinalized,
  ): BrokerJobFinalized {
    let selected = finalized;
    let bytes = jobLogLineBytes("consult/finalized", {
      jobId: job.jobId,
      ...selected,
    });
    if (job.persistedLogBytes + bytes > maxPersistedLogBytes) {
      selected = logLimitFinalized();
      bytes = jobLogLineBytes("consult/finalized", {
        jobId: job.jobId,
        ...selected,
      });
    }
    if (job.persistedLogBytes + bytes > maxPersistedLogBytes) {
      throw new Error("terminal Job limit diagnostic exceeds maxPersistedLogBytes");
    }
    job.persistedLogBytes += bytes;
    return selected;
  }

  function logLimitFinalized(): BrokerJobFinalized {
    return {
      stopReason: "failed",
      sessionId: null,
      errorMessage: jobLimitErrorMessage(JOB_LOG_LIMIT_EXCEEDED, maxPersistedLogBytes),
    };
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
    await persistJobRecord(stateWorkspaceRoot, job.jobId, finalizedBrokerJobRecord(existing, job as BrokerJobSnapshot, finalized as FinalizedJobOutcome));
  }

  async function writeFailedJobRecord(job: BrokerJob) {
    const existing = await readExistingJobRecord(job.jobId);
    await persistJobRecord(stateWorkspaceRoot, job.jobId, failedBrokerJobRecord(existing, job as BrokerJobSnapshot & { finalized: FinalizedJobOutcome }));
  }

  async function readExistingJobRecord(jobId: string) {
    try {
      return await readWorkspaceJobRecord(stateWorkspaceRoot, jobId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  function terminalWriteFailure(job: BrokerJob, error: unknown): BrokerJobFinalized {
    return {
      stopReason: "failed",
      sessionId: job.sessionId,
      errorMessage: `job record write failed: ${errorMessage(error)}`,
    };
  }
}

function defaultScheduleWallClock(handler: () => void, milliseconds: number): NodeJS.Timeout {
  return setTimeout(handler, milliseconds);
}

function defaultClearWallClock(timer: NodeJS.Timeout): void {
  clearTimeout(timer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositiveLimit(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

// Tool kinds a read-only Job permits regardless of who approved them (mirrors
// decidePermission in permissions.mts). An agent auto-approving one of these is
// not a permission-gate bypass, so the read-only backstop must not terminate
// the turn for it. Some Profiles (e.g. opencode) auto-approve their own read
// tools and report the tool call with `auto_approved: true`; only auto-approved
// mutating or unclassified kinds signal a real bypass worth failing on.
const READ_ONLY_AUTO_APPROVAL_SAFE_KINDS = new Set(["read", "search", "think"]);

function readOnlyPermitsAutoApprovedKind(kind: string | null, allowFetch: boolean): boolean {
  if (kind === null) return false;
  if (READ_ONLY_AUTO_APPROVAL_SAFE_KINDS.has(kind)) return true;
  return kind === "fetch" && allowFetch;
}

function isAutoApprovedPolicyViolation(job: BrokerJob, update: BrokerSessionUpdate): boolean {
  return autoApprovedPolicyViolationMessage(job, update) !== null;
}

function autoApprovedPolicyViolationMessage(job: BrokerJob, update: BrokerSessionUpdate): string | null {
  const toolCall = update?.toolCall ?? update;
  const rawInput = toolCall?.rawInput ?? update?.rawInput;
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind.toLowerCase() : null;
  const autoApproved = rawInput?.auto_approved === true || rawInput?.autoApproved === true;
  const mode = job.authority.mode;

  if (mode === "read-only") {
    if (autoApproved && !readOnlyPermitsAutoApprovedKind(kind, job.authority.allowFetch === true)) {
      return `policy violation: auto-approved ${kind ?? "unknown"} update in read-only mode`;
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
