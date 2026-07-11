import type { JobRecord } from "./job-records.mts";
import { jobAuthorityFromRecord } from "./job-authority.mts";
import type { JobAuthority } from "./job-authority.mts";

export const JOB_RESULT_SCHEMA_VERSION = 1 as const;

export interface JobResultJob {
  id: string | null;
  kind: string | null;
  status: string | null;
  profile: string | null;
  authority: JobAuthority;
  mode: string | null;
  host: string | null;
  hostSessionId: string | null;
  prompt: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  model: string | null;
  effort: string | null;
  afterJobIds: string[];
  resumeSessionId: string | null;
  baseRef: string | null;
  includeDiff: boolean;
  isolated: boolean;
  allowExecute: boolean;
}

export interface JobResultOutcome {
  stopReason: string | null;
  sessionId: string | null;
  errorMessage: string | null;
  finalText: string | null;
}

export interface JobResultArtifacts {
  touchedFiles: string[];
  logPath: string | null;
  patchPath: string | null;
  patchBytes: number | null;
  touchedFilesPath: string | null;
  cleanupMetadataPath: string | null;
}

export interface JobResultLineage {
  chainId: string | null;
  parentJobId: string | null;
  childJobIds: string[];
  delegationDepth: number | null;
}

export interface JobResultPayload {
  job: JobResultJob;
  outcome: JobResultOutcome;
  artifacts: JobResultArtifacts;
  lineage: JobResultLineage;
}

export interface JobResultEnvelope extends JobResultPayload {
  schemaVersion: typeof JOB_RESULT_SCHEMA_VERSION;
}

export interface JobResultPayloadOptions {
  childJobIds?: readonly string[];
  logPath?: string | null;
}

/**
 * Convert the mutable, internal Job record into the stable public result shape.
 * Unknown record fields are intentionally not copied into the CLI contract.
 */
export function jobResultPayload(
  record: JobRecord,
  { childJobIds = [], logPath = null }: JobResultPayloadOptions = {},
): JobResultPayload {
  const authority = resultAuthority(record);
  return {
    job: {
      id: stringOrNull(record.jobId),
      kind: stringOrNull(record.kind),
      status: stringOrNull(record.status),
      profile: stringOrNull(record.profile),
      authority,
      mode: stringOrNull(record.mode),
      host: stringOrNull(record.host),
      hostSessionId: stringOrNull(record.hostSessionId),
      prompt: stringOrNull(record.prompt),
      submittedAt: stringOrNull(record.submittedAt),
      startedAt: stringOrNull(record.startedAt),
      completedAt: stringOrNull(record.completedAt),
      model: stringOrNull(record.model),
      effort: stringOrNull(record.effort),
      afterJobIds: stringArray(record.afterJobIds),
      resumeSessionId: stringOrNull(record.resumeSessionId),
      baseRef: stringOrNull(record.baseRef),
      includeDiff: record.includeDiff === true,
      isolated: record.isolated === true,
      allowExecute: record.allowExecute === true,
    },
    outcome: {
      stopReason: stringOrNull(record.stopReason),
      sessionId: stringOrNull(record.sessionId),
      errorMessage: stringOrNull(record.errorMessage),
      finalText: stringOrNull(record.finalText),
    },
    artifacts: {
      touchedFiles: stringArray(record.touchedFiles),
      logPath,
      patchPath: stringOrNull(record.patchPath),
      patchBytes: nonNegativeIntegerOrNull(record.patchBytes),
      touchedFilesPath: stringOrNull(record.touchedFilesPath),
      cleanupMetadataPath: stringOrNull(record.cleanupMetadataPath),
    },
    lineage: {
      chainId: stringOrNull(record.chainId),
      parentJobId: stringOrNull(record.parentJobId),
      childJobIds: [...childJobIds],
      delegationDepth: integerOrNull(record.delegationDepth),
    },
  };
}

export function jobResultEnvelope(
  record: JobRecord,
  options: JobResultPayloadOptions = {},
): JobResultEnvelope {
  return {
    schemaVersion: JOB_RESULT_SCHEMA_VERSION,
    ...jobResultPayload(record, options),
  };
}

function resultAuthority(record: JobRecord): JobAuthority {
  const result = jobAuthorityFromRecord(record);
  if (result.ok) {
    return result.authority;
  }
  const error = new Error(result.diagnostic.message) as Error & {
    code?: string;
    diagnostic?: unknown;
  };
  error.code = result.diagnostic.code;
  error.diagnostic = result.diagnostic;
  throw error;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
