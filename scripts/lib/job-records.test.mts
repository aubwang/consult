import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { jobsDir, logsDir } from "./broker-endpoint.mts";
import {
  appendJobLogLine,
  createQueuedJobRecord,
  failJobRecord,
  finalizeJobRecord,
  isFinalStatus,
  jobLogPath,
  jobRecordPath,
  listWorkspaceJobRecords,
  markJobRunning,
  readWorkspaceJobRecord,
  statusFromStopReason,
  writeJobRecord,
} from "./job-records.mts";
import type { JobRecord } from "./job-records.mts";

test("createQueuedJobRecord creates a queued record with a submitted timestamp", () => {
  const record = createQueuedJobRecord(
    {
      jobId: "job-queued",
      kind: "delegate",
      profile: "codex",
    },
    { now: () => "2026-05-21T10:00:00.000Z" },
  );

  assert.deepEqual(record, {
    jobId: "job-queued",
    kind: "delegate",
    profile: "codex",
    status: "queued",
    submittedAt: "2026-05-21T10:00:00.000Z",
  });
});

test("markJobRunning records running status and preserves an existing started timestamp", () => {
  const record: JobRecord = { jobId: "job-running", startedAt: "2026-05-21T09:59:00.000Z" };

  const returned = markJobRunning(record, { now: () => "2026-05-21T10:01:00.000Z" });

  assert.equal(returned, record);
  assert.equal(record.status, "running");
  assert.equal(record.startedAt, "2026-05-21T09:59:00.000Z");
});

test("finalizeJobRecord maps completed, cancelled, and failed stop reasons", () => {
  const completed = finalizeJobRecord(
    { jobId: "job-completed" },
    {
      stopReason: "end_turn",
      sessionId: "session-1",
      finalText: "done",
      now: () => "2026-05-21T10:02:00.000Z",
    },
  );
  const cancelled = finalizeJobRecord(
    { jobId: "job-cancelled" },
    {
      stopReason: "cancelled",
      sessionId: "session-2",
      now: () => "2026-05-21T10:03:00.000Z",
    },
  );
  const failed = finalizeJobRecord(
    { jobId: "job-failed" },
    {
      stopReason: "failed",
      sessionId: "session-3",
      errorMessage: "nope",
      now: () => "2026-05-21T10:04:00.000Z",
    },
  );

  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAt, "2026-05-21T10:02:00.000Z");
  assert.equal(completed.finalText, "done");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completedAt, "2026-05-21T10:03:00.000Z");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorMessage, "nope");
});

test("failJobRecord marks a record failed with the shared timestamp convention", () => {
  const record = failJobRecord(
    { jobId: "job-failed" },
    {
      errorMessage: "broker not running",
      finalText: "partial",
      now: () => "2026-05-21T10:05:00.000Z",
    },
  );

  assert.deepEqual(record, {
    jobId: "job-failed",
    status: "failed",
    completedAt: "2026-05-21T10:05:00.000Z",
    errorMessage: "broker not running",
    finalText: "partial",
  });
});

test("final status helpers centralize status conventions", () => {
  assert.equal(statusFromStopReason("cancelled"), "cancelled");
  assert.equal(statusFromStopReason("failed"), "failed");
  assert.equal(statusFromStopReason("end_turn"), "completed");
  assert.equal(isFinalStatus("completed"), true);
  assert.equal(isFinalStatus("cancelled"), true);
  assert.equal(isFinalStatus("failed"), true);
  assert.equal(isFinalStatus("running"), false);
});

test("workspace job persistence reads, writes, lists, and appends logs", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  await writeJobRecord(workspaceRoot, "job-old", {
    jobId: "job-old",
    submittedAt: "2026-05-21T10:00:00.000Z",
  });
  await writeJobRecord(workspaceRoot, "job-new", {
    jobId: "job-new",
    submittedAt: "2026-05-21T10:01:00.000Z",
  });
  await appendJobLogLine(workspaceRoot, "job-new", {
    method: "consult/update",
    params: { jobId: "job-new" },
  });

  assert.deepEqual(await readWorkspaceJobRecord(workspaceRoot, "job-new"), {
    jobId: "job-new",
    submittedAt: "2026-05-21T10:01:00.000Z",
  });
  assert.deepEqual(
    (await listWorkspaceJobRecords(workspaceRoot)).map((record) => record.jobId),
    ["job-new", "job-old"],
  );
  assert.equal(
    await fs.readFile(path.join(logsDir(workspaceRoot), "job-new.log"), "utf8"),
    `${JSON.stringify({ method: "consult/update", params: { jobId: "job-new" } })}\n`,
  );
  assert.ok(await fs.stat(path.join(jobsDir(workspaceRoot), "job-new.json")));
});

test("workspace job persistence confines unsafe job ids to safe filenames", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const unsafeJobId = "../../../../escape/pwn";
  const escapedDir = path.join(path.dirname(dataDir), "escape");
  await fs.mkdir(escapedDir);

  await writeJobRecord(workspaceRoot, unsafeJobId, {
    jobId: unsafeJobId,
    submittedAt: "2026-05-21T10:02:00.000Z",
  });
  await appendJobLogLine(workspaceRoot, unsafeJobId, { method: "consult/update" });

  assert.deepEqual(await readWorkspaceJobRecord(workspaceRoot, unsafeJobId), {
    jobId: unsafeJobId,
    submittedAt: "2026-05-21T10:02:00.000Z",
  });
  assert.equal(path.dirname(jobRecordPath(workspaceRoot, unsafeJobId)), jobsDir(workspaceRoot));
  assert.equal(path.dirname(jobLogPath(workspaceRoot, unsafeJobId)), logsDir(workspaceRoot));
  await assert.rejects(fs.stat(path.join(escapedDir, "pwn.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(escapedDir, "pwn.log")), { code: "ENOENT" });
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-job-records-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

function withDataDir(t: TestContext, dataDir: string) {
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = dataDir;
  t.after(() => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
  });
}
