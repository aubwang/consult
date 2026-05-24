import path from "node:path";

import { cancelPrompt } from "./acp-client.mjs";
import { cancelCascadeJobTargets } from "./delegation-chain.mjs";
import {
  failedBrokerJobRecord,
  finalizedBrokerJobRecord,
  readWorkspaceJobRecord,
  writeJobRecord as persistJobRecord,
} from "./job-records.mjs";
import { isInsideWorkspaceSync } from "./path-safety.mjs";

export function createBrokerJobRuntime({
  config,
  ensureAgent,
  hashRunPayload,
  writeNotification,
  onActivity = () => {},
  onTerminal = () => {},
}) {
  const sessionJobs = new Map();
  const sessionModes = new Map();
  const activeJobs = new Map();
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
      const job = {
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
        await failJobForPolicyViolation(job, autoApprovedPolicyViolationMessage(job, update));
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
      await writeJobRecord(job, finalized);
      // Keep finalized jobs for this daemon lifetime; eviction is deferred for v1.
      notifyFinalized(job, finalized);
      onActivity();
      onTerminal(job);
    },
    async failJob(job, errorMessage) {
      clearCancelAckTimer(job);
      job.status = "finalized";
      job.completedAt = new Date().toISOString();
      job.finalized = {
        stopReason: "failed",
        sessionId: job.sessionId,
        errorMessage,
      };
      sessionJobs.delete(job.sessionId);
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
      const currentAgent = await ensureAgent();
      await cancelPrompt(currentAgent.connection, { sessionId: job.sessionId });
    },
    cancelJobCascade(job) {
      const { descendants, targets } = cancelCascadeJobTargets(job, activeJobs.values());
      for (const target of targets) {
        this.cancelJob(target).catch(() => {});
      }
      return descendants.map((candidate) => candidate.jobId);
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
  };

  function writeJobUpdate(job, update) {
    const notification = { jobId: job.jobId, update };
    job.finalText += renderUpdate(update);
    job.pendingUpdates.push(notification);
    if (job.pendingUpdates.length > 500) {
      job.pendingUpdates.shift();
    }
    for (const subscriber of job.subscribers) {
      writeNotification(subscriber, "consult/update", notification);
    }
  }

  async function failJobForPolicyViolation(job, errorMessage) {
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
    busy = false;
    job.cancelRequested = true;
    ensureAgent()
      .then((agent) => cancelPrompt(agent.connection, { sessionId: job.sessionId }))
      .catch(() => {});
    await writeFailedJobRecord(job);
    notifyFinalized(job, job.finalized);
    onActivity();
    onTerminal(job);
  }

  function startCancelAckTimer(job) {
    if (job.cancelAckTimer) {
      return;
    }
    job.cancelAckTimer = setTimeout(() => {
      if (job.status !== "running") {
        return;
      }
      job.status = "finalized";
      job.completedAt = new Date().toISOString();
      job.finalized = {
        stopReason: "failed",
        sessionId: job.sessionId,
        errorMessage: "agent did not acknowledge cancel",
      };
      sessionJobs.delete(job.sessionId);
      busy = false;
      tainted = true;
      writeFailedJobRecord(job).catch(() => {});
      notifyFinalized(job, job.finalized);
      onActivity();
      onTerminal(job);
    }, config.cancelAckTimeoutMs);
  }

  function clearCancelAckTimer(job) {
    if (job.cancelAckTimer) {
      clearTimeout(job.cancelAckTimer);
      job.cancelAckTimer = null;
    }
  }

  function notifyFinalized(job, finalized) {
    for (const subscriber of job.subscribers) {
      writeNotification(subscriber, "consult/finalized", {
        jobId: job.jobId,
        ...finalized,
      });
    }
    job.subscribers.clear();
  }

  async function writeJobRecord(job, finalized) {
    const existing = await readExistingJobRecord(job.jobId);
    await persistJobRecord(config.cwd, job.jobId, finalizedBrokerJobRecord(existing, job, finalized));
  }

  async function writeFailedJobRecord(job) {
    const existing = await readExistingJobRecord(job.jobId);
    await persistJobRecord(config.cwd, job.jobId, failedBrokerJobRecord(existing, job));
  }

  async function readExistingJobRecord(jobId) {
    try {
      return await readWorkspaceJobRecord(config.cwd, jobId);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }
}

function isAutoApprovedPolicyViolation(job, update) {
  return autoApprovedPolicyViolationMessage(job, update) !== null;
}

function autoApprovedPolicyViolationMessage(job, update) {
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

function extractTouchedPath(update, workspaceRoot) {
  const paths = [
    update?.locations?.[0]?.path,
    update?.toolCall?.rawInput?.path,
    update?.toolCall?.rawInput?.file_path,
    update?.rawInput?.path,
    update?.rawInput?.file_path,
  ];
  const touchedPath = paths.find((candidate) => {
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

function isTouchedPathInsideWorkspace(touchedPath, workspaceRoot) {
  if (!workspaceRoot) {
    return false;
  }
  try {
    return isInsideWorkspaceSync(touchedPath, workspaceRoot);
  } catch {
    return false;
  }
}

function renderUpdate(update) {
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  if (update.sessionUpdate === "tool_call") {
    return `[tool_call ${update.toolCall?.name ?? update.name ?? "unknown"}]\n`;
  }
  return "";
}
