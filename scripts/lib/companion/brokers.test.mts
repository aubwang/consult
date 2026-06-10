import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { brokerFilePath, brokersDir } from "../broker-endpoint.mts";
import { runBrokers } from "./brokers.mts";

test("brokers lists running, stale, and malformed broker state", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeBrokerState(workspaceRoot, {
    jobId: "job-live",
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    pid: 100,
    startedAt: "2026-05-24T00:00:00.000Z",
  });
  await writeBrokerState(workspaceRoot, {
    jobId: "job-stale",
    host: "terminal",
    hostSessionId: "default",
    profile: "claude",
    pid: 200,
  });
  await writeRawBroker(workspaceRoot, "job-bad", "{");

  const result = await runBrokers({
    args: { positional: [], flags: { json: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidAlive: async (pid) => pid === 100,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    (JSON.parse(result.stdout) as Array<{ jobId: string; status: string }>).map(({ jobId, status }) => ({ jobId, status })),
    [
      { jobId: "job-bad", status: "malformed" },
      { jobId: "job-live", status: "running" },
      { jobId: "job-stale", status: "stale" },
    ],
  );
});

test("brokers prints an empty table when no broker state exists", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runBrokers({
    args: { positional: [], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /jobId\tprofile\tstatus/);
  assert.match(result.stdout, /\(no brokers\)/);
});

test("brokers --cleanup removes stale and malformed brokers but leaves live brokers", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const liveFile = await writeBrokerState(workspaceRoot, {
    jobId: "job-live",
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    pid: 100,
  });
  const staleFile = await writeBrokerState(workspaceRoot, {
    jobId: "job-stale",
    host: "terminal",
    hostSessionId: "default",
    profile: "claude",
    pid: 200,
  });
  const malformedFile = await writeRawBroker(workspaceRoot, "job-bad", "[]");

  const result = await runBrokers({
    args: { positional: [], flags: { cleanup: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidAlive: async (pid) => pid === 100,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /job-bad\tmalformed\tremoved/);
  assert.match(result.stdout, /job-stale\tstale\tremoved/);
  assert.equal(await fileExists(liveFile), true);
  assert.equal(await fileExists(staleFile), false);
  assert.equal(await fileExists(malformedFile), false);
});

test("brokers --cleanup with a job id tears down a running broker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeBrokerState(workspaceRoot, {
    jobId: "job-live",
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    pid: 100,
  });
  let teardownArgs: unknown;

  const result = await runBrokers({
    args: { positional: ["job-live"], flags: { cleanup: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidAlive: async () => true,
      teardownBrokerSession: async (args) => {
        teardownArgs = args;
        return { teardown: "shutdown", brokerFile: "/tmp/broker.json" };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /job-live\trunning\tshutdown/);
  assert.deepEqual(teardownArgs, {
    workspaceRoot,
    jobId: "job-live",
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
  });
});

test("brokers exits 2 when a requested job has no broker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runBrokers({
    args: { positional: ["missing"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "broker not found for job: missing\n");
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-brokers-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

function withDataDir(t: { after: (fn: () => void) => void }, dataDir: string): void {
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

async function writeBrokerState(
  workspaceRoot: string,
  state: Record<string, unknown>,
): Promise<string> {
  const filePath = brokerFilePath({ workspaceRoot, ...state } as Parameters<typeof brokerFilePath>[0]);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
  return filePath;
}

async function writeRawBroker(
  workspaceRoot: string,
  jobId: string,
  content: string,
): Promise<string> {
  const filePath = path.join(brokersDir(workspaceRoot), `${jobId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
