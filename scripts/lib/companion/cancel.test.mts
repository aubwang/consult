import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { runCancel } from "./cancel.mts";

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
  let ensureArgs: Record<string, unknown> | undefined;

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async (args) => {
        ensureArgs = args as unknown as Record<string, unknown>;
        return { client: client as never, alreadyRunning: true };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(ensureArgs?.jobId, "job-active");
  assert.equal(ensureArgs?.profile, "codex");
  assert.equal(ensureArgs?.hostSessionId, "claude-1");
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
      connectBrokerSession: async () => ({ client: client as never, alreadyRunning: true }),
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
      connectBrokerSession: async () => ({ client: client as never, alreadyRunning: true }),
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
  const terminated: number[] = [];

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client: client as never, alreadyRunning: true }),
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
  const terminated: number[] = [];

  const result = await runCancel({
    args: { positional: ["job-active"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client: client as never, alreadyRunning: true }),
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

test("cancel preserves partial output when a cascade target fails", async (t) => {
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
    status: "running",
    profile: "codex",
    chainId: "job-parent",
    parentJobId: "job-parent",
    host: null,
    hostSessionId: null,
  });
  const client = new FakeBrokerClient({ ok: true });

  const result = await runCancel({
    args: { positional: ["job-parent"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client: client as never, alreadyRunning: true }),
    },
  });

  assert.equal(result.exitCode, 2);
  // The parent was already cancelled before the child failed; that output
  // must not be discarded.
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stderr, /invalid job record job-child: missing host identity/);
});

test("cancel signals a live inline runner instead of dialing a broker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline",
    status: "running",
    profile: "codex",
    runner: "inline",
    runnerPid: 4242,
  });
  const signalled: Array<[number, string]> = [];

  const result = await runCancel({
    args: { positional: ["job-inline"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be touched for an inline job");
      },
      pidIsAlive: (pid) => pid === 4242,
      signalPid: (pid, signal) => {
        signalled.push([pid, signal]);
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(signalled, [[4242, "SIGTERM"]]);
  assert.match(result.stdout, /inline runner pid 4242 signalled/);
  // The record settles via the signalled companion, not the cancel command.
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-inline.json"), "utf8"),
  );
  assert.equal(record.status, "running");
});

test("cancel marks an inline job cancelled when the runner pid is dead", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline-dead",
    status: "running",
    profile: "codex",
    runner: "inline",
    runnerPid: 4242,
  });

  const result = await runCancel({
    args: { positional: ["job-inline-dead"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be touched for an inline job");
      },
      pidIsAlive: () => false,
      signalPid: () => {
        throw new Error("dead pid must not be signalled");
      },
      now: () => "2026-05-14T10:01:00.000Z",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /inline runner not running/);
  assert.match(result.stdout, /record marked cancelled/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-inline-dead.json"), "utf8"),
  );
  assert.equal(record.status, "cancelled");
  assert.equal(record.stopReason, "cancelled");
  assert.equal(record.errorMessage, "inline runner not running at cancel time");
  assert.equal(record.completedAt, "2026-05-14T10:01:00.000Z");
});

test("cancel settles an inline job when the runner dies between check and signal", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline-esrch",
    status: "running",
    profile: "codex",
    runner: "inline",
    runnerPid: 4242,
  });

  const result = await runCancel({
    args: { positional: ["job-inline-esrch"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidIsAlive: () => true,
      signalPid: () => {
        const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /record marked cancelled/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-inline-esrch.json"), "utf8"),
  );
  assert.equal(record.status, "cancelled");
});

test("cancel reports a permission error instead of crashing on EPERM", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline-eperm",
    status: "running",
    profile: "codex",
    runner: "inline",
    runnerPid: 4242,
  });

  const result = await runCancel({
    args: { positional: ["job-inline-eperm"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidIsAlive: () => true,
      signalPid: () => {
        const error = new Error("kill EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /permission denied \(pid likely reused\)/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-inline-eperm.json"), "utf8"),
  );
  assert.equal(record.status, "running");
});

test("cancel treats a reused inline runner pid as dead via the start-time check", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline-reused",
    status: "running",
    profile: "codex",
    runner: "inline",
    runnerPid: 4242,
    runnerStartTime: "111111",
  });

  const result = await runCancel({
    args: { positional: ["job-inline-reused"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidIsAlive: () => true,
      pidMatchesStartTime: async () => false,
      signalPid: () => {
        throw new Error("a reused pid must not be signalled");
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /record marked cancelled/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-inline-reused.json"), "utf8"),
  );
  assert.equal(record.status, "cancelled");
});

test("cancel marks an active job cancelled when the broker is unreachable", async (t) => {
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
        const error = new Error("unreachable") as NodeJS.ErrnoException;
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
  assert.match(result.stdout, /record marked cancelled/);
  assert.match(result.stdout, /consult brokers --cleanup/);
  // Cancel yields the documented `cancelled` lifecycle status, with the
  // unreachable-broker diagnostic preserved in the message.
  assert.equal(record.status, "cancelled");
  assert.equal(record.stopReason, "cancelled");
  assert.equal(record.errorMessage, "broker not running at cancel time");
  assert.equal(record.completedAt, "2026-05-14T10:01:00.000Z");
});

test("cancel re-reads before writing and preserves a concurrently stamped worker pid", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-cancel-race",
    status: "queued",
    profile: "codex",
    submittedAt: "2026-05-14T10:00:00.000Z",
  });
  const terminated: number[] = [];

  const result = await runCancel({
    args: { positional: ["job-cancel-race"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        await writeJob(workspaceRoot, {
          jobId: "job-cancel-race",
          status: "queued",
          profile: "codex",
          submittedAt: "2026-05-14T10:00:00.000Z",
          workerPid: 24680,
          runnerStartTime: "12345",
        });
        const error = new Error("unreachable") as NodeJS.ErrnoException;
        error.code = "BROKER_UNREACHABLE";
        throw error;
      },
      pidIsAlive: (pid) => pid === 24680,
      terminateProcessTree: async (pid) => { terminated.push(pid); },
    },
  });

  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-cancel-race.json"), "utf8"),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(record.status, "cancelled");
  assert.equal(record.workerPid, 24680);
  assert.equal(record.runnerStartTime, "12345");
  assert.deepEqual(terminated, [24680]);
});

test("cancel rejects an aliased lookup whose record jobId does not match", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-alias-source",
    status: "running",
    profile: "codex",
  });
  await fs.rename(
    path.join(jobsDir(workspaceRoot), "job-alias-source.json"),
    path.join(jobsDir(workspaceRoot), "job-alias-target.json"),
  );

  const result = await runCancel({
    args: { positional: ["job-alias-target"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker must not be contacted for an aliased record");
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /job (?:id mismatch|not found)/u);
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

function withDataDir(t: { after: (fn: () => void) => void }, dataDir: string) {
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
  await fs.writeFile(
    path.join(dir, `${record.jobId}.json`),
    JSON.stringify({
      host: "claude-code",
      hostSessionId: "claude-1",
      ...record,
    }),
  );
}

async function writeMalformedJob(workspaceRoot: string, jobId: string) {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");
  return recordPath;
}

class FakeBrokerClient {
  response: unknown;
  requests: Array<{ method: string; params: unknown }> = [];

  constructor(response: unknown) {
    this.response = response;
  }

  async request(method: string, params: unknown) {
    this.requests.push({ method, params });
    return this.response;
  }
}
