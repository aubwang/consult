import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mjs";
import { runCancel } from "./cancel.mjs";

test("cancel is idempotent for finalized jobs", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-done", status: "completed", profile: "codex" });

  const result = await runCancel({
    args: { positional: ["job-done"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be touched");
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /already finalized \(status=completed\)/);
});

test("cancel sends consult/cancel when the broker is reachable", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-active", status: "running", profile: "codex" });
  const client = new FakeBrokerClient({ ok: true });
  let ensureArgs;

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async (args) => {
        ensureArgs = args;
        return { client, alreadyRunning: true };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(ensureArgs.jobId, "job-active");
  assert.equal(ensureArgs.profile, "codex");
  assert.equal(ensureArgs.hostSessionId, "claude-1");
  assert.deepEqual(client.requests, [{ method: "consult/cancel", params: { jobId: "job-active" } }]);
  assert.match(result.stdout, /"ok":true/);
});

test("cancel cascades from a parent job to active descendants", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-parent",
    status: "running",
    profile: "codex",
    chainId: "job-parent",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-child",
    status: "queued",
    profile: "codex",
    chainId: "job-parent",
    parentJobId: "job-parent",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-grandchild",
    status: "completed",
    profile: "codex",
    chainId: "job-parent",
    parentJobId: "job-child",
  });
  const client = new FakeBrokerClient({ ok: true });

  const result = await runCancel({
    args: { positional: ["job-parent"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client, alreadyRunning: true }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(client.requests, [
    { method: "consult/cancel", params: { jobId: "job-parent" } },
    { method: "consult/cancel", params: { jobId: "job-child" } },
  ]);
  assert.match(result.stdout, /cascade job-child: \{"ok":true\}/);
});

test("cancel of a finalized parent still cancels active descendants", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-parent",
    status: "completed",
    profile: "codex",
    chainId: "job-parent",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-child",
    status: "running",
    profile: "codex",
    chainId: "job-parent",
    parentJobId: "job-parent",
  });
  const client = new FakeBrokerClient({ ok: true });

  const result = await runCancel({
    args: { positional: ["job-parent"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client, alreadyRunning: true }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(client.requests, [
    { method: "consult/cancel", params: { jobId: "job-child" } },
  ]);
  assert.match(result.stdout, /already finalized \(status=completed\); cancelling 1 active/);
});

test("cancel terminates a live worker process after broker cancel succeeds", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    workerPid: 12345,
  });
  const client = new FakeBrokerClient({ ok: true });
  const terminated = [];

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client, alreadyRunning: true }),
      pidIsAlive: (pid) => pid === 12345,
      terminateProcessTree: async (pid) => {
        terminated.push(pid);
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(client.requests, [{ method: "consult/cancel", params: { jobId: "job-active" } }]);
  assert.deepEqual(terminated, [12345]);
  assert.match(result.stdout, /worker pid 12345 terminated/);
});

test("cancel ignores a stale worker pid after broker cancel succeeds", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    workerPid: 12345,
  });
  const client = new FakeBrokerClient({ ok: true });
  const terminated = [];

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client, alreadyRunning: true }),
      pidIsAlive: () => false,
      terminateProcessTree: async (pid) => {
        terminated.push(pid);
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(client.requests, [{ method: "consult/cancel", params: { jobId: "job-active" } }]);
  assert.deepEqual(terminated, []);
  assert.doesNotMatch(result.stdout, /worker pid/);
});

test("cancel marks an active job failed when the broker is unreachable", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-orphan",
    status: "running",
    profile: "codex",
    submittedAt: "2026-05-14T10:00:00.000Z",
  });

  const result = await runCancel({
    args: { positional: ["job-orphan"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        const error = new Error("unreachable");
        error.code = "BROKER_UNREACHABLE";
        throw error;
      },
      now: () => "2026-05-14T10:01:00.000Z",
    },
  });

  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-orphan.json"), "utf8"),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /broker not running/);
  assert.match(result.stdout, /consult brokers --cleanup/);
  assert.equal(record.status, "failed");
  assert.equal(record.errorMessage, "broker not running at cancel time");
  assert.equal(record.completedAt, "2026-05-14T10:01:00.000Z");
});

test("cancel exits 2 for an unknown job id", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runCancel({
    args: { positional: ["missing"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /job not found: missing/);
});

test("cancel exits 2 for a malformed job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = await writeMalformedJob(workspaceRoot, "job-bad");

  const result = await runCancel({
    args: { positional: ["job-bad"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

test("cancel requires host identity in active job records", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "job-active.json"),
    JSON.stringify({ jobId: "job-active", status: "running", profile: "codex" }),
  );

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /missing host identity/);
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-cancel-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

function withDataDir(t, dataDir) {
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

async function writeJob(workspaceRoot, record) {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record.jobId}.json`),
    JSON.stringify({
      host: "claude-code",
      hostSessionId: "claude-1",
      ...record,
    }),
  );
}

async function writeMalformedJob(workspaceRoot, jobId) {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");
  return recordPath;
}

class FakeBrokerClient {
  constructor(response) {
    this.response = response;
    this.requests = [];
  }

  async request(method, params) {
    this.requests.push({ method, params });
    return this.response;
  }
}
