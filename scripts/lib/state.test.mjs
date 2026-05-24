import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { atomicWriteJson, listJobRecords, readJobRecord } from "./state.mjs";

test("atomicWriteJson writes JSON that round-trips from disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const destPath = path.join(dir, "record.json");
  const value = { status: "completed", sessionId: "session-1" };

  await atomicWriteJson(destPath, value);

  const contents = await fs.readFile(destPath, "utf8");
  assert.deepEqual(JSON.parse(contents), value);
});

test("atomicWriteJson renames from a sibling tempfile", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const destPath = path.join(dir, "record.json");
  const originalRename = fs.rename.bind(fs);
  let sawRename = false;

  t.mock.method(fs, "rename", async (fromPath, toPath) => {
    sawRename = true;
    assert.equal(path.dirname(fromPath), path.dirname(destPath));
    assert.equal(toPath, destPath);

    const [tempParent, destParent] = await Promise.all([
      fs.stat(path.dirname(fromPath)),
      fs.stat(path.dirname(destPath)),
    ]);
    assert.equal(tempParent.dev, destParent.dev);
    assert.equal(tempParent.ino, destParent.ino);

    return originalRename(fromPath, toPath);
  });

  await atomicWriteJson(destPath, { status: "running" });

  assert.equal(sawRename, true);
});

test("atomicWriteJson propagates EXDEV without copy fallback", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const destPath = path.join(dir, "record.json");
  const exdev = Object.assign(new Error("cross-device link not permitted"), {
    code: "EXDEV",
  });

  t.mock.method(fs, "rename", async () => {
    throw exdev;
  });

  await assert.rejects(
    atomicWriteJson(destPath, { status: "failed" }),
    (error) => error.code === "EXDEV",
  );
  await assert.rejects(fs.stat(destPath), { code: "ENOENT" });
});

test("readJobRecord reads a job record by id", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  await fs.mkdir(jobsDir);
  await fs.writeFile(
    path.join(jobsDir, "job-1.json"),
    JSON.stringify({ jobId: "job-1", status: "completed" }),
  );

  const record = await readJobRecord(jobsDir, "job-1");

  assert.deepEqual(record, { jobId: "job-1", status: "completed" });
});

test("readJobRecord rejects malformed JSON with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  const recordPath = path.join(jobsDir, "job-bad.json");
  await fs.mkdir(jobsDir);
  await fs.writeFile(recordPath, "{", "utf8");

  await assert.rejects(readJobRecord(jobsDir, "job-bad"), (error) => {
    assert.equal(error.code, "JOB_RECORD_MALFORMED");
    assert.equal(error.message, `Job record is malformed: ${recordPath}`);
    assert.equal(error.path, recordPath);
    return true;
  });
});

test("readJobRecord rejects non-object JSON with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  const recordPath = path.join(jobsDir, "job-bad.json");
  await fs.mkdir(jobsDir);
  await fs.writeFile(recordPath, "null", "utf8");

  await assert.rejects(readJobRecord(jobsDir, "job-bad"), (error) => {
    assert.equal(error.code, "JOB_RECORD_MALFORMED");
    assert.equal(error.message, `Job record is malformed: ${recordPath}`);
    assert.equal(error.path, recordPath);
    return true;
  });
});

test("listJobRecords returns submitted jobs newest first", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  await fs.mkdir(jobsDir);
  await fs.writeFile(
    path.join(jobsDir, "old.json"),
    JSON.stringify({ jobId: "old", submittedAt: "2026-05-14T09:00:00.000Z" }),
  );
  await fs.writeFile(
    path.join(jobsDir, "new.json"),
    JSON.stringify({ jobId: "new", submittedAt: "2026-05-14T10:00:00.000Z" }),
  );

  const records = await listJobRecords(jobsDir);

  assert.deepEqual(
    records.map((record) => record.jobId),
    ["new", "old"],
  );
});

test("listJobRecords rejects malformed JSON with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  const recordPath = path.join(jobsDir, "bad.json");
  await fs.mkdir(jobsDir);
  await fs.writeFile(recordPath, "{", "utf8");

  await assert.rejects(listJobRecords(jobsDir), (error) => {
    assert.equal(error.code, "JOB_RECORD_MALFORMED");
    assert.equal(error.message, `Job record is malformed: ${recordPath}`);
    assert.equal(error.path, recordPath);
    return true;
  });
});

test("listJobRecords rejects non-object JSON with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-state-"));
  const jobsDir = path.join(dir, "jobs");
  const recordPath = path.join(jobsDir, "bad.json");
  await fs.mkdir(jobsDir);
  await fs.writeFile(recordPath, "[]", "utf8");

  await assert.rejects(listJobRecords(jobsDir), (error) => {
    assert.equal(error.code, "JOB_RECORD_MALFORMED");
    assert.equal(error.message, `Job record is malformed: ${recordPath}`);
    assert.equal(error.path, recordPath);
    return true;
  });
});
