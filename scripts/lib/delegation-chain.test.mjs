import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeDescendantRecords,
  addJobRelationships,
  cancelCascadeJobTargets,
  cancelCascadeRecordTargets,
  resolveNewJobChain,
} from "./delegation-chain.mjs";
import { isFinalStatus } from "./job-records.mjs";

test("resolveNewJobChain creates root lineage for a top-level job", async () => {
  const result = await resolveNewJobChain({
    workspaceRoot: "/workspace",
    jobId: "job-root",
    parentJobId: null,
    requestedMode: "write",
    writeExplicit: false,
  });

  assert.deepEqual(result, {
    parent: null,
    fields: {
      chainId: "job-root",
      parentJobId: null,
      delegationDepth: 0,
    },
    mode: "write",
  });
});

test("resolveNewJobChain inherits lineage and read-only permission ceiling", async () => {
  const result = await resolveNewJobChain({
    workspaceRoot: "/workspace",
    jobId: "job-child",
    parentJobId: "job-parent",
    requestedMode: "write",
    writeExplicit: false,
    readJobRecord: async () => ({
      jobId: "job-parent",
      chainId: "job-root",
      delegationDepth: 1,
      mode: "read-only",
    }),
  });

  assert.deepEqual(result.fields, {
    chainId: "job-root",
    parentJobId: "job-parent",
    delegationDepth: 2,
  });
  assert.equal(result.mode, "read-only");
});

test("resolveNewJobChain preserves delegation cap and explicit write errors", async () => {
  const tooDeep = await resolveNewJobChain({
    workspaceRoot: "/workspace",
    jobId: "job-child",
    parentJobId: "job-parent",
    requestedMode: "write",
    writeExplicit: false,
    readJobRecord: async () => ({
      jobId: "job-parent",
      chainId: "job-root",
      delegationDepth: 2,
      mode: "write",
    }),
  });
  const tooPermissive = await resolveNewJobChain({
    workspaceRoot: "/workspace",
    jobId: "job-child",
    parentJobId: "job-parent",
    requestedMode: "write",
    writeExplicit: true,
    readJobRecord: async () => ({
      jobId: "job-parent",
      chainId: "job-root",
      delegationDepth: 0,
      mode: "read-only",
    }),
  });

  assert.equal(tooDeep.error, "delegation depth 3 exceeds max 2");
  assert.equal(tooPermissive.error, "child job cannot use --write when parent job is read-only");
});

test("relationship enrichment adds direct children and finds active descendants", () => {
  const records = recordsFixture();

  assert.deepEqual(addJobRelationships(records[0], records).childJobIds, [
    "job-child-a",
    "job-child-b",
    "job-other-chain",
  ]);
  assert.deepEqual(
    activeDescendantRecords("job-root", records, { isFinalStatus }).map((record) => record.jobId),
    ["job-child-a", "job-grandchild"],
  );
});

test("cancelCascadeRecordTargets selects active descendants for persisted records", () => {
  const records = recordsFixture();
  const activeRoot = cancelCascadeRecordTargets(records[0], records, { isFinalStatus });
  const finalizedRoot = cancelCascadeRecordTargets(
    { ...records[0], status: "completed" },
    records,
    { isFinalStatus },
  );

  assert.deepEqual(
    activeRoot.targets.map((record) => record.jobId),
    ["job-root", "job-child-a", "job-grandchild"],
  );
  assert.deepEqual(
    finalizedRoot.targets.map((record) => record.jobId),
    ["job-child-a", "job-grandchild"],
  );
});

test("cancelCascadeJobTargets uses the same descendant rules for live broker jobs", () => {
  const root = { jobId: "job-root", status: "running", chainId: "job-root" };
  const child = {
    jobId: "job-child",
    status: "running",
    chainId: "job-root",
    parentJobId: "job-root",
  };
  const completedChild = {
    jobId: "job-completed",
    status: "finalized",
    chainId: "job-root",
    parentJobId: "job-root",
  };
  const grandchild = {
    jobId: "job-grandchild",
    status: "running",
    chainId: "job-root",
    parentJobId: "job-completed",
  };

  const cascade = cancelCascadeJobTargets(root, [root, child, completedChild, grandchild]);

  assert.deepEqual(
    cascade.descendants.map((job) => job.jobId),
    ["job-child", "job-grandchild"],
  );
  assert.deepEqual(
    cascade.targets.map((job) => job.jobId),
    ["job-root", "job-child", "job-grandchild"],
  );
});

test("cancelCascadeJobTargets traverses one-shot live job iterators across passes", () => {
  const root = { jobId: "job-root", status: "finalized", chainId: "job-root" };
  const grandchild = {
    jobId: "job-grandchild",
    status: "running",
    chainId: "job-root",
    parentJobId: "job-child",
  };
  const child = {
    jobId: "job-child",
    status: "running",
    chainId: "job-root",
    parentJobId: "job-root",
  };
  const liveJobs = new Map([
    [root.jobId, root],
    [grandchild.jobId, grandchild],
    [child.jobId, child],
  ]);

  const cascade = cancelCascadeJobTargets(root, liveJobs.values());

  assert.deepEqual(
    cascade.targets.map((job) => job.jobId),
    ["job-child", "job-grandchild"],
  );
});

function recordsFixture() {
  return [
    { jobId: "job-root", status: "running", chainId: "job-root" },
    {
      jobId: "job-child-a",
      status: "running",
      chainId: "job-root",
      parentJobId: "job-root",
    },
    {
      jobId: "job-grandchild",
      status: "queued",
      chainId: "job-root",
      parentJobId: "job-child-a",
    },
    {
      jobId: "job-child-b",
      status: "completed",
      chainId: "job-root",
      parentJobId: "job-root",
    },
    {
      jobId: "job-other-chain",
      status: "running",
      chainId: "other",
      parentJobId: "job-root",
    },
  ];
}
