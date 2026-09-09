import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanHistory } from "./clean.mts";
import { writeJobRecord, readWorkspaceJobRecord, appendJobLogLine, jobLogPath } from "../job-records.mts";

test("cleanup previews first, retains dependencies and recovery work, and prevents resurrection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-clean-"));
  const previous = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(root, "data");
  t.after(async () => {
    if (previous === undefined) delete process.env.CONSULT_DATA_DIR; else process.env.CONSULT_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const completedAt = "2025-01-01T00:00:00.000Z";
  for (const jobId of ["expired", "needed", "recovery"]) {
    await writeJobRecord(root, jobId, { jobId, status: "completed", completedAt,
      ...(jobId === "recovery" ? { recoveryWorkspace: "/somewhere" } : {}) });
  }
  await appendJobLogLine(root, "expired", { message: "old" });
  await writeJobRecord(root, "active", { jobId: "active", status: "running", afterJobIds: ["needed"] });
  const options = { olderThanDays: 30, now: Date.parse("2026-01-01T00:00:00.000Z") };
  assert.deepEqual((await cleanHistory(root, options)).jobIds, ["expired"]);
  assert.equal((await readWorkspaceJobRecord(root, "expired")).status, "completed");
  assert.deepEqual((await cleanHistory(root, { ...options, apply: true })).jobIds, ["expired"]);
  await assert.rejects(readWorkspaceJobRecord(root, "expired"), { code: "ENOENT" });
  await assert.rejects(fs.access(jobLogPath(root, "expired")), { code: "ENOENT" });
  assert.equal((await readWorkspaceJobRecord(root, "needed")).status, "completed");
  await assert.rejects(writeJobRecord(root, "expired", { jobId: "expired", status: "completed" }), /removed by retention/);
  await assert.rejects(writeJobRecord(root, "new", { jobId: "new", status: "queued", afterJobIds: ["expired"] }), /removed by retention/);
});
