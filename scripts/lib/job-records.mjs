import fs from "node:fs/promises";
import path from "node:path";

import { jobsDir, logsDir } from "./broker-endpoint.mjs";
import {
  atomicWriteJson,
  listJobRecords as listJobRecordsFromDir,
  readJobRecord as readJobRecordFromDir,
} from "./state.mjs";

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

export const FINAL_JOB_STATUSES = Object.freeze([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.CANCELLED,
  JOB_STATUS.FAILED,
]);

export function createQueuedJobRecord(fields, { now = defaultNow } = {}) {
  return {
    ...fields,
    status: JOB_STATUS.QUEUED,
    submittedAt: fields.submittedAt ?? now(),
  };
}

export function markJobRunning(record, { now = defaultNow } = {}) {
  Object.assign(record, {
    status: JOB_STATUS.RUNNING,
    startedAt: record.startedAt ?? now(),
  });
  return record;
}

export function finalizeJobRecord(
  record,
  { stopReason, sessionId, touchedFiles, errorMessage, finalText, completedAt, now = defaultNow },
) {
  const fields = {
    status: statusFromStopReason(stopReason),
    completedAt: completedAt ?? now(),
    stopReason,
    sessionId,
    touchedFiles,
    finalText,
  };
  if (errorMessage !== undefined) {
    fields.errorMessage = errorMessage;
  }
  Object.assign(record, omitUndefined(fields));
  return record;
}

export function failJobRecord(
  record,
  { errorMessage, sessionId, finalText, completedAt, stopReason, now = defaultNow },
) {
  Object.assign(
    record,
    omitUndefined({
      status: JOB_STATUS.FAILED,
      completedAt: completedAt ?? now(),
      stopReason,
      errorMessage,
      sessionId,
      finalText,
    }),
  );
  return record;
}

export function statusFromStopReason(stopReason) {
  if (stopReason === "cancelled") {
    return JOB_STATUS.CANCELLED;
  }
  if (stopReason === "failed") {
    return JOB_STATUS.FAILED;
  }
  return JOB_STATUS.COMPLETED;
}

export function isFinalStatus(status) {
  return FINAL_JOB_STATUSES.includes(status);
}

export async function readWorkspaceJobRecord(workspaceRoot, jobId) {
  return await readJobRecordFromDir(jobsDir(workspaceRoot), jobId);
}

export async function listWorkspaceJobRecords(workspaceRoot) {
  return await listJobRecordsFromDir(jobsDir(workspaceRoot));
}

export async function writeJobRecord(workspaceRoot, jobId, record) {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(path.join(dir, `${jobId}.json`), record);
}

export async function appendJobLogLine(workspaceRoot, jobId, notification) {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${jobId}.log`), `${JSON.stringify(notification)}\n`);
}

export function brokerJobMetadata(job) {
  return Object.fromEntries(
    [
      ["kind", job.kind],
      ["host", job.host],
      ["hostSessionId", job.hostSessionId],
      ["profile", job.profile],
      ["mode", job.mode],
      ["prompt", job.prompt],
      ["submittedAt", job.submittedAt],
      ["chainId", job.chainId],
      ["parentJobId", job.parentJobId],
      ["delegationDepth", job.delegationDepth],
      ["model", job.model],
      ["effort", job.effort],
      ["resumeSessionId", job.resumeSessionId],
      ["baseRef", job.baseRef],
    ].filter(([, value]) => value !== undefined),
  );
}

export function finalizedBrokerJobRecord(existing, job, finalized) {
  return {
    ...existing,
    jobId: job.jobId,
    ...brokerJobMetadata(job),
    status: statusFromStopReason(finalized.stopReason),
    stopReason: finalized.stopReason,
    sessionId: finalized.sessionId,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    finalText: job.finalText,
  };
}

export function failedBrokerJobRecord(existing, job) {
  return {
    ...existing,
    jobId: job.jobId,
    ...brokerJobMetadata(job),
    status: JOB_STATUS.FAILED,
    errorMessage: job.finalized.errorMessage,
    sessionId: job.sessionId,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    finalText: job.finalText,
  };
}

function defaultNow() {
  return new Date().toISOString();
}

function omitUndefined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
