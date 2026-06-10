import { readWorkspaceJobRecord } from "./job-records.mts";
import type { JobRecord } from "./job-records.mts";

export const DEFAULT_MAX_DELEGATION_DEPTH = 2;

export type ReadJobRecordFn = (
  workspaceRoot: string,
  jobId: string,
) => Promise<JobRecord | null | undefined>;

export interface ChainLineageFields {
  chainId: string | undefined;
  parentJobId: string | null | undefined;
  delegationDepth: number;
}

export interface ResolveNewJobChainOptions {
  workspaceRoot: string;
  jobId: string;
  parentJobId?: string | null;
  requestedMode?: string;
  writeExplicit?: boolean;
  maxDepth?: number;
  readJobRecord?: ReadJobRecordFn;
}

export interface NewJobChainResolution {
  parent?: JobRecord | null;
  fields?: ChainLineageFields;
  mode?: string;
  error?: string;
}

export async function resolveNewJobChain({
  workspaceRoot,
  jobId,
  parentJobId,
  requestedMode,
  writeExplicit,
  maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
  readJobRecord = readWorkspaceJobRecord,
}: ResolveNewJobChainOptions): Promise<NewJobChainResolution> {
  const parentResolution = await resolveParentJobRecord({
    workspaceRoot,
    parentJobId,
    readJobRecord,
  });
  if (parentResolution.error) {
    return { error: parentResolution.error };
  }
  const lineage = resolveLineage(jobId, parentResolution.parent, { maxDepth });
  if (lineage.error) {
    return { error: lineage.error };
  }
  const permission = resolvePermissionCeiling({
    requestedMode,
    writeExplicit,
    parent: parentResolution.parent,
  });
  if (permission.error) {
    return { error: permission.error };
  }
  return {
    parent: parentResolution.parent,
    fields: lineage.fields,
    mode: permission.mode,
  };
}

export interface ResolveParentJobRecordOptions {
  workspaceRoot: string;
  parentJobId?: string | null;
  readJobRecord: ReadJobRecordFn;
}

export interface ParentJobResolution {
  parent?: JobRecord | null;
  error?: string;
}

export async function resolveParentJobRecord({
  workspaceRoot,
  parentJobId,
  readJobRecord,
}: ResolveParentJobRecordOptions): Promise<ParentJobResolution> {
  if (!parentJobId) {
    return { parent: null };
  }
  let parent: JobRecord | null | undefined;
  try {
    parent = await readJobRecord(workspaceRoot, parentJobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `parent job not found: ${parentJobId}` };
    }
    throw error;
  }
  if (!parent) {
    return { error: `parent job not found: ${parentJobId}` };
  }
  if (parent.jobId !== parentJobId) {
    return { error: `parent job record mismatch: ${parentJobId}` };
  }
  return { parent };
}

export interface ResolveLineageOptions {
  maxDepth?: number;
}

export interface LineageResolution {
  fields?: ChainLineageFields;
  error?: string;
}

export function resolveLineage(
  jobId: string,
  parent: JobRecord | null | undefined,
  { maxDepth = DEFAULT_MAX_DELEGATION_DEPTH }: ResolveLineageOptions = {},
): LineageResolution {
  if (!parent) {
    return {
      fields: {
        chainId: jobId,
        parentJobId: null,
        delegationDepth: 0,
      },
    };
  }

  const parentDepth = Number.isInteger(parent.delegationDepth)
    ? (parent.delegationDepth as number)
    : 0;
  const delegationDepth = parentDepth + 1;
  if (delegationDepth > maxDepth) {
    return {
      error: `delegation depth ${delegationDepth} exceeds max ${maxDepth}`,
    };
  }
  return {
    fields: {
      chainId: parent.chainId ?? parent.jobId,
      parentJobId: parent.jobId,
      delegationDepth,
    },
  };
}

export interface PermissionCeilingOptions {
  requestedMode?: string;
  writeExplicit?: boolean;
  parent?: JobRecord | null;
}

export interface PermissionCeilingResolution {
  mode?: string;
  error?: string;
}

export function resolvePermissionCeiling({
  requestedMode,
  writeExplicit,
  parent,
}: PermissionCeilingOptions): PermissionCeilingResolution {
  if (!parent || parent.mode !== "read-only") {
    return { mode: requestedMode };
  }
  if (writeExplicit) {
    return { error: "child job cannot use --write when parent job is read-only" };
  }
  return { mode: "read-only" };
}

export function addJobRelationships(
  record: JobRecord,
  records: JobRecord[],
): JobRecord & { childJobIds: string[] } {
  return {
    ...record,
    childJobIds: directChildJobIds(record.jobId, records),
  };
}

export function directChildJobIds(jobId: string | undefined, records: JobRecord[]): string[] {
  return records
    .filter((candidate) => candidate.parentJobId === jobId)
    .map((candidate) => candidate.jobId)
    .filter(Boolean)
    .sort() as string[];
}

export interface FinalStatusOptions {
  isFinalStatus: (status: string | undefined) => boolean;
}

export function activeDescendantRecords(
  jobId: string | undefined,
  records: JobRecord[],
  { isFinalStatus }: FinalStatusOptions,
): JobRecord[] {
  return descendantItems(
    records.find((record) => record.jobId === jobId) ?? { jobId },
    records,
    {
      isActive: (record) => !isFinalStatus(record.status),
    },
  );
}

export interface CancelCascadeRecordTargets {
  activeDescendants: JobRecord[];
  targets: JobRecord[];
}

export function cancelCascadeRecordTargets(
  record: JobRecord,
  records: JobRecord[],
  { isFinalStatus }: FinalStatusOptions,
): CancelCascadeRecordTargets {
  const activeDescendants = activeDescendantRecords(record.jobId, records, { isFinalStatus });
  return {
    activeDescendants,
    targets: isFinalStatus(record.status) ? activeDescendants : [record, ...activeDescendants],
  };
}

export interface CascadeJobItem {
  jobId?: string;
  status?: string;
  chainId?: string;
  parentJobId?: string | null;
}

export interface CancelCascadeJobTargets<T extends CascadeJobItem> {
  descendants: T[];
  targets: T[];
}

export function cancelCascadeJobTargets<T extends CascadeJobItem>(
  job: T,
  jobs: Iterable<T>,
): CancelCascadeJobTargets<T> {
  const descendants = descendantItems(job, jobs, {
    isActive: (candidate) => candidate.status === "running",
  });
  return {
    descendants,
    targets: job.status === "running" ? [job, ...descendants] : descendants,
  };
}

function descendantItems<T extends CascadeJobItem>(
  root: T,
  items: Iterable<T>,
  { isActive }: { isActive: (item: T) => boolean },
): T[] {
  const itemList = [...items];
  const chainId = root.chainId ?? root.jobId;
  const descendants: T[] = [];
  const parentIds = new Set<string | null | undefined>([root.jobId]);
  const visitedIds = new Set<string | undefined>([root.jobId]);
  let found = true;
  while (found) {
    found = false;
    for (const candidate of itemList) {
      if (visitedIds.has(candidate.jobId)) {
        continue;
      }
      if (candidate.chainId !== undefined && candidate.chainId !== chainId) {
        continue;
      }
      if (!parentIds.has(candidate.parentJobId)) {
        continue;
      }
      visitedIds.add(candidate.jobId);
      if (isActive(candidate)) {
        descendants.push(candidate);
      }
      parentIds.add(candidate.jobId);
      found = true;
    }
  }
  return descendants;
}
