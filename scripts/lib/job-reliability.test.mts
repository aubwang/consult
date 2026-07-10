import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { appendJobLogLine, jobLogPath } from "./job-records.mts";
import {
  DEFAULT_JOB_LOG_LIMIT_BYTES,
  DEFAULT_JOB_WALL_CLOCK_LIMIT_MS,
  jobLogLineBytes,
} from "./job-reliability.mts";

test("portable Job reliability defaults are fixed and explicit", () => {
  assert.equal(DEFAULT_JOB_WALL_CLOCK_LIMIT_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_JOB_LOG_LIMIT_BYTES, 16 * 1024 * 1024);
});

test("jobLogLineBytes exactly matches persisted UTF-8 NDJSON bytes", async (t: TestContext) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-job-limit-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = dataDir;
  t.after(async () => {
    if (oldDataDir === undefined) delete process.env.CONSULT_DATA_DIR;
    else process.env.CONSULT_DATA_DIR = oldDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const params = {
    jobId: "job-bytes",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "multibyte: 雪" },
    },
  };
  await appendJobLogLine(workspaceRoot, "job-bytes", {
    method: "consult/update",
    params,
  });

  const stat = await fs.stat(jobLogPath(workspaceRoot, "job-bytes"));
  assert.equal(stat.size, jobLogLineBytes("consult/update", params));
});
