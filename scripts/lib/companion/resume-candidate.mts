import {
  JOB_STATUS,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord, JobStatus } from "../job-records.mts";

const RESUMABLE_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED]);

export type ListJobRecordsFn = (workspaceRoot: string) => Promise<JobRecord[]>;
export type ReadJobRecordFn = (
  workspaceRoot: string,
  jobId: string,
) => Promise<JobRecord | null | undefined>;

export interface FindResumeCandidateOptions {
  host?: string;
  hostSessionId?: string;
  listJobRecords?: ListJobRecordsFn;
}

export interface FindResumeJobCandidateOptions {
  readJobRecord?: ReadJobRecordFn;
}

export interface ResumeCandidateFound {
  record: JobRecord;
  error?: undefined;
}

export interface ResumeCandidateError {
  error: string;
  record?: undefined;
}

export type ResumeJobCandidateResult = ResumeCandidateFound | ResumeCandidateError;

export async function findResumeCandidate(
  workspaceRoot: string,
  profile: string,
  { host, hostSessionId, listJobRecords = listWorkspaceJobRecords }: FindResumeCandidateOptions = {},
): Promise<JobRecord | null> {
  const candidates: JobRecord[] = [];
  for (const record of await listJobRecords(workspaceRoot)) {
    if (
      record?.profile === profile &&
      (host === undefined || record.host === host) &&
      (hostSessionId === undefined || record.hostSessionId === hostSessionId) &&
      RESUMABLE_STATUSES.has(record.status as JobStatus) &&
      record.sessionId &&
      record.completedAt
    ) {
      candidates.push(record);
    }
  }
  candidates.sort((left, right) =>
    (left.completedAt as string).localeCompare(right.completedAt as string),
  );
  return candidates.at(-1) ?? null;
}

export async function findResumeJobCandidate(
  workspaceRoot: string,
  jobId: string,
  profile: string,
  { readJobRecord = readWorkspaceJobRecord }: FindResumeJobCandidateOptions = {},
): Promise<ResumeJobCandidateResult> {
  const record = await readJobRecord(workspaceRoot, jobId);
  if (record?.profile !== profile) {
    const ownerProfile = record?.profile ?? "unknown";
    return {
      error: `resume job '${jobId}' belongs to profile '${ownerProfile}'; select profile '${ownerProfile}' or choose a ${profile} job`,
    };
  }
  if (!RESUMABLE_STATUSES.has(record.status as JobStatus) || !record.sessionId) {
    return {
      error: `resume job '${jobId}' is not resumable`,
    };
  }
  return { record: record as JobRecord };
}
