import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobRecord } from "../job-records.mts";
import { runChain } from "./chain.mts";

test("chain prints a human rollup for the requested job chain", async (t) => {
  const records: JobRecord[] = [
    {
    jobId: "job-root",
    profile: "codex",
    status: "completed",
    submittedAt: "2026-05-14T10:00:00.000Z",
    completedAt: "2026-05-14T10:01:00.000Z",
    chainId: "job-root",
    parentJobId: null,
    delegationDepth: 0,
    prompt: "root prompt",
    finalText: "root summary",
  },
  {
    jobId: "job-child",
    profile: "claude",
    status: "running",
    submittedAt: "2026-05-14T10:02:00.000Z",
    chainId: "job-root",
    parentJobId: "job-root",
    delegationDepth: 1,
    prompt: "child prompt",
  },
  {
    jobId: "job-sibling",
    profile: "opencode",
    status: "failed",
    submittedAt: "2026-05-14T10:03:00.000Z",
    chainId: "job-root",
    parentJobId: "job-root",
    delegationDepth: 1,
    prompt: "sibling prompt",
    finalText: "sibling failed summary",
  },
  {
    jobId: "job-grandchild",
    profile: "codex",
    status: "queued",
    submittedAt: "2026-05-14T10:04:00.000Z",
    chainId: "job-root",
    parentJobId: "job-child",
    delegationDepth: 2,
    prompt: "grandchild prompt",
  },
  {
    jobId: "job-other",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:05:00.000Z",
    chainId: "job-other",
    parentJobId: null,
    delegationDepth: 0,
  },
  ];

  const result = await runChain({
    args: { positional: ["job-child"], flags: {} },
    deps: testDeps(records),
  });

  assert.equal(result.exitCode, 0);
  assert.match(
    result.stdout,
    /^chain\tjob-root\tjob\tjob-child\troot\tjob-root\tparent\tjob-root\tchildren\tjob-grandchild/m,
  );
  assert.match(result.stdout, /relation\tjobId\tstatus\tprofile\tdepth\tparentJobId\tchildren\tprompt\tfinalSummary/);
  assert.match(result.stdout, /root,parent\tjob-root\tcompleted\tcodex\t0\t-\tjob-child,job-sibling\troot prompt\troot summary/);
  assert.match(result.stdout, /target\tjob-child\trunning\tclaude\t1\tjob-root\tjob-grandchild\tchild prompt\t-/);
  assert.match(result.stdout, /chain\tjob-sibling\tfailed\topencode\t1\tjob-root\t-\tsibling prompt\tsibling failed summary/);
  assert.match(result.stdout, /child\tjob-grandchild\tqueued\tcodex\t2\tjob-child\t-\tgrandchild prompt\t-/);
  assert.doesNotMatch(result.stdout, /job-other/);
});

test("chain json emits structured rollup and records", async (t) => {
  const records: JobRecord[] = [
    {
    jobId: "job-root",
    profile: "codex",
    status: "completed",
    submittedAt: "2026-05-14T10:00:00.000Z",
    chainId: "job-root",
    parentJobId: null,
    delegationDepth: 0,
    prompt: "root prompt",
    finalText: "root final",
  },
  {
    jobId: "job-child",
    profile: "claude",
    status: "completed",
    submittedAt: "2026-05-14T10:01:00.000Z",
    chainId: "job-root",
    parentJobId: "job-root",
    delegationDepth: 1,
    prompt: "child prompt",
    finalText: "child final",
  },
  ];

  const result = await runChain({
    args: { positional: ["job-root"], flags: { json: true } },
    deps: testDeps(records),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    rollup: {
      requestedJobId: "job-root",
      chainId: "job-root",
      rootJobId: "job-root",
      parentJobId: null,
      childJobIds: ["job-child"],
    },
    records: [
      {
        jobId: "job-root",
        relations: ["root", "target"],
        status: "completed",
        profile: "codex",
        parentJobId: null,
        childJobIds: ["job-child"],
        delegationDepth: 0,
        prompt: "root prompt",
        finalText: "root final",
      },
      {
        jobId: "job-child",
        relations: ["child"],
        status: "completed",
        profile: "claude",
        parentJobId: "job-root",
        childJobIds: [],
        delegationDepth: 1,
        prompt: "child prompt",
        finalText: "child final",
      },
    ],
  });
});

test("chain exits 2 for a missing job", async (t) => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });

  const result = await runChain({
    args: { positional: ["missing"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => "/workspace",
      readJobRecord: async () => {
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "job not found: missing\n");
});

test("chain exits 2 for a malformed requested job record", async (t) => {
  const recordPath = "/workspace/.consult/jobs/job-bad.json";
  const error = Object.assign(new Error("bad record"), {
    code: "JOB_RECORD_MALFORMED",
    path: recordPath,
  });

  const result = await runChain({
    args: { positional: ["job-bad"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => "/workspace",
      readJobRecord: async () => {
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

function testDeps(records: JobRecord[]) {
  return {
    resolveWorkspaceRoot: async () => "/workspace",
    readJobRecord: async (_workspaceRoot: string, jobId: string) => {
      const record = records.find((candidate) => candidate.jobId === jobId);
      if (!record) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return record;
    },
    listJobRecords: async () => records,
  };
}
