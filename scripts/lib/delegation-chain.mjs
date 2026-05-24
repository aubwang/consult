import { readWorkspaceJobRecord } from "./job-records.mjs";

export const DEFAULT_MAX_DELEGATION_DEPTH = 2;

export async function resolveNewJobChain({
  workspaceRoot,
  jobId,
  parentJobId,
  requestedMode,
  writeExplicit,
  maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
  readJobRecord = readWorkspaceJobRecord,
}) {
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

export async function resolveParentJobRecord({ workspaceRoot, parentJobId, readJobRecord }) {
  if (!parentJobId) {
    return { parent: null };
  }
  let parent;
  try {
    parent = await readJobRecord(workspaceRoot, parentJobId);
  } catch (error) {
    if (error.code === "ENOENT") {
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

export function resolveLineage(jobId, parent, { maxDepth = DEFAULT_MAX_DELEGATION_DEPTH } = {}) {
  if (!parent) {
    return {
      fields: {
        chainId: jobId,
        parentJobId: null,
        delegationDepth: 0,
      },
    };
  }

  const parentDepth = Number.isInteger(parent.delegationDepth) ? parent.delegationDepth : 0;
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

export function resolvePermissionCeiling({ requestedMode, writeExplicit, parent }) {
  if (!parent || parent.mode !== "read-only") {
    return { mode: requestedMode };
  }
  if (writeExplicit) {
    return { error: "child job cannot use --write when parent job is read-only" };
  }
  return { mode: "read-only" };
}

export function addJobRelationships(record, records) {
  return {
    ...record,
    childJobIds: directChildJobIds(record.jobId, records),
  };
}

export function directChildJobIds(jobId, records) {
  return records
    .filter((candidate) => candidate.parentJobId === jobId)
    .map((candidate) => candidate.jobId)
    .filter(Boolean)
    .sort();
}

export function activeDescendantRecords(jobId, records, { isFinalStatus }) {
  return descendantItems(
    records.find((record) => record.jobId === jobId) ?? { jobId },
    records,
    {
      isActive: (record) => !isFinalStatus(record.status),
    },
  );
}

export function cancelCascadeRecordTargets(record, records, { isFinalStatus }) {
  const activeDescendants = activeDescendantRecords(record.jobId, records, { isFinalStatus });
  return {
    activeDescendants,
    targets: isFinalStatus(record.status) ? activeDescendants : [record, ...activeDescendants],
  };
}

export function cancelCascadeJobTargets(job, jobs) {
  const descendants = descendantItems(job, jobs, {
    isActive: (candidate) => candidate.status === "running",
  });
  return {
    descendants,
    targets: job.status === "running" ? [job, ...descendants] : descendants,
  };
}

function descendantItems(root, items, { isActive }) {
  const itemList = [...items];
  const chainId = root.chainId ?? root.jobId;
  const descendants = [];
  const parentIds = new Set([root.jobId]);
  const visitedIds = new Set([root.jobId]);
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
