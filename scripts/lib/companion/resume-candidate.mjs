import {
  JOB_STATUS,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mjs";

const RESUMABLE_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED]);

export async function findResumeCandidate(
  workspaceRoot,
  profile,
  { host, hostSessionId, listJobRecords = listWorkspaceJobRecords } = {},
) {
  const candidates = [];
  for (const record of await listJobRecords(workspaceRoot)) {
    if (
      record?.profile === profile &&
      (host === undefined || record.host === host) &&
      (hostSessionId === undefined || record.hostSessionId === hostSessionId) &&
      RESUMABLE_STATUSES.has(record.status) &&
      record.sessionId &&
      record.completedAt
    ) {
      candidates.push(record);
    }
  }
  candidates.sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  return candidates.at(-1) ?? null;
}

export async function findResumeJobCandidate(
  workspaceRoot,
  jobId,
  profile,
  { readJobRecord = readWorkspaceJobRecord } = {},
) {
  const record = await readJobRecord(workspaceRoot, jobId);
  if (record?.profile !== profile) {
    const ownerProfile = record?.profile ?? "unknown";
    return {
      error: `resume job '${jobId}' belongs to profile '${ownerProfile}'; select profile '${ownerProfile}' or choose a ${profile} job`,
    };
  }
  if (!RESUMABLE_STATUSES.has(record.status) || !record.sessionId) {
    return {
      error: `resume job '${jobId}' is not resumable`,
    };
  }
  return { record };
}
