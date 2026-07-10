import fs from "node:fs/promises";
import path from "node:path";

import { jobsDir, logsDir } from "./broker-endpoint.mts";
import {
  atomicWriteJson,
  listJobRecords as listJobRecordsFromDir,
  readJobRecord as readJobRecordFromDir,
} from "./state.mts";
import { omitUndefined } from "./objects.mts";
import { safeSegment } from "./path-segments.mts";
import type { PreparedIsolatedWorkspace } from "./isolated-workspace.mts";
import type { JobAuthority } from "./job-authority.mts";

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
} as const);

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const FINAL_JOB_STATUSES: readonly JobStatus[] = Object.freeze([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.CANCELLED,
  JOB_STATUS.FAILED,
]);

export interface JobRecord extends Record<string, unknown> {
  jobId?: string;
  kind?: string;
  host?: string;
  hostSessionId?: string;
  profile?: string;
  authority?: JobAuthority;
  mode?: string;
  prompt?: string;
  status?: string;
  submittedAt?: string;
  startedAt?: string;
  completedAt?: string;
  stopReason?: string;
  sessionId?: string;
  touchedFiles?: string[];
  errorMessage?: string;
  finalText?: string;
  chainId?: string;
  parentJobId?: string | null;
  delegationDepth?: number;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  baseRef?: string;
  includeDiff?: boolean;
  isolated?: boolean;
  allowExecute?: boolean;
  isolatedWorkspace?: PreparedIsolatedWorkspace;
  patchPath?: string;
  patchBytes?: number;
  touchedFilesPath?: string;
  cleanupMetadataPath?: string;
  // Foreground jobs run in-process in the companion (ADR-0021): runner is
  // "inline" and runnerPid is the companion pid `consult cancel` signals.
  // runnerStartTime guards that signal against pid reuse.
  runner?: string;
  runnerPid?: number;
  runnerStartTime?: string;
}

export interface JobClockOptions {
  now?: () => string;
}

export interface FinalizeJobRecordOptions extends JobClockOptions {
  stopReason?: string;
  sessionId?: string;
  touchedFiles?: string[];
  errorMessage?: string;
  finalText?: string;
  completedAt?: string;
}

export interface FailJobRecordOptions extends JobClockOptions {
  errorMessage?: string;
  sessionId?: string;
  finalText?: string;
  completedAt?: string;
  stopReason?: string;
}

export function createQueuedJobRecord(
  fields: JobRecord,
  { now = defaultNow }: JobClockOptions = {},
): JobRecord {
  return {
    ...fields,
    status: JOB_STATUS.QUEUED,
    submittedAt: fields.submittedAt ?? now(),
  };
}

export function markJobRunning(
  record: JobRecord,
  { now = defaultNow }: JobClockOptions = {},
): JobRecord {
  Object.assign(record, {
    status: JOB_STATUS.RUNNING,
    startedAt: record.startedAt ?? now(),
  });
  return record;
}

export function finalizeJobRecord(
  record: JobRecord,
  {
    stopReason,
    sessionId,
    touchedFiles,
    errorMessage,
    finalText,
    completedAt,
    now = defaultNow,
  }: FinalizeJobRecordOptions,
): JobRecord {
  const fields: JobRecord = {
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
  record: JobRecord,
  {
    errorMessage,
    sessionId,
    finalText,
    completedAt,
    stopReason,
    now = defaultNow,
  }: FailJobRecordOptions,
): JobRecord {
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

export function statusFromStopReason(stopReason: unknown): JobStatus {
  if (stopReason === "cancelled") {
    return JOB_STATUS.CANCELLED;
  }
  if (stopReason === "failed") {
    return JOB_STATUS.FAILED;
  }
  return JOB_STATUS.COMPLETED;
}

export function isFinalStatus(status: unknown): boolean {
  return FINAL_JOB_STATUSES.includes(status as JobStatus);
}

export async function readWorkspaceJobRecord(
  workspaceRoot: string,
  jobId: string,
): Promise<JobRecord> {
  return (await readJobRecordFromDir(jobsDir(workspaceRoot), jobId)) as JobRecord;
}

export async function listWorkspaceJobRecords(workspaceRoot: string): Promise<JobRecord[]> {
  return (await listJobRecordsFromDir(jobsDir(workspaceRoot))) as JobRecord[];
}

export function jobRecordPath(workspaceRoot: string, jobId: string): string {
  return path.join(jobsDir(workspaceRoot), `${safeSegment(jobId)}.json`);
}

export function jobLogPath(workspaceRoot: string, jobId: string): string {
  return path.join(logsDir(workspaceRoot), `${safeSegment(jobId)}.log`);
}

export async function writeJobRecord(
  workspaceRoot: string,
  jobId: string,
  record: JobRecord,
): Promise<void> {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteJson(jobRecordPath(workspaceRoot, jobId), record);
}

export async function appendJobLogLine(
  workspaceRoot: string,
  jobId: string,
  notification: unknown,
): Promise<void> {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(jobLogPath(workspaceRoot, jobId), `${JSON.stringify(notification)}\n`);
}

export interface BrokerJobMetadataFields {
  kind?: string;
  host?: string;
  hostSessionId?: string;
  profile?: string;
  authority?: JobAuthority;
  mode?: string;
  prompt?: string;
  submittedAt?: string;
  chainId?: string;
  parentJobId?: string | null;
  delegationDepth?: number;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  baseRef?: string;
  isolated?: boolean;
  allowExecute?: boolean;
}

export interface FinalizedJobOutcome {
  stopReason?: string;
  sessionId?: string;
  errorMessage?: string;
}

export interface BrokerJobSnapshot extends BrokerJobMetadataFields {
  jobId?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  finalText?: string;
  finalized?: FinalizedJobOutcome;
}

export function brokerJobMetadata(job: BrokerJobMetadataFields): BrokerJobMetadataFields {
  return Object.fromEntries(
    [
      ["kind", job.kind],
      ["host", job.host],
      ["hostSessionId", job.hostSessionId],
      ["profile", job.profile],
      ["authority", job.authority],
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
      ["isolated", job.isolated],
      ["allowExecute", job.allowExecute],
    ].filter(([, value]) => value !== undefined),
  ) as BrokerJobMetadataFields;
}

export function finalizedBrokerJobRecord(
  existing: JobRecord,
  job: BrokerJobSnapshot,
  finalized: FinalizedJobOutcome,
): JobRecord {
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

export function failedBrokerJobRecord(
  existing: JobRecord,
  job: BrokerJobSnapshot & { finalized: FinalizedJobOutcome },
): JobRecord {
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

function defaultNow(): string {
  return new Date().toISOString();
}
