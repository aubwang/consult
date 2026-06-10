import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { runResult } from "./result.mts";

test("result prints finalText for a completed job", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-done",
    status: "completed",
    finalText: "final answer\n",
  });

  const result = await runResult({
    args: { positional: ["job-done"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "final answer\n");
});

test("result exits 5 when the job is still running", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running" });

  const result = await runResult({
    args: { positional: ["job-running"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 5);
  assert.match(result.stderr, /job not finished; current status: running/);
});

test("result exits 2 for an unknown job id", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runResult({
    args: { positional: ["missing"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /job not found: missing/);
});

test("result exits 2 for a malformed job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = await writeMalformedJob(workspaceRoot, "job-bad");

  const result = await runResult({
    args: { positional: ["job-bad"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

test("result json mode prints the full record with child job ids", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-json",
    status: "completed",
    finalText: "json answer",
    sessionId: "session-1",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-child",
    status: "completed",
    parentJobId: "job-json",
    finalText: "child answer",
  });

  const result = await runResult({
    args: { positional: ["job-json"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    jobId: "job-json",
    status: "completed",
    finalText: "json answer",
    sessionId: "session-1",
    childJobIds: ["job-child"],
  });
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-result-"));
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

async function writeJob(workspaceRoot: string, record: Record<string, unknown>) {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.jobId as string}.json`), JSON.stringify(record));
}

async function writeMalformedJob(workspaceRoot: string, jobId: string) {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");
  return recordPath;
}
