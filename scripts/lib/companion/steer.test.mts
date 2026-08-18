import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { MAX_STEER_GUIDANCE_BYTES } from "../job-steer.mts";
import { runSteer } from "./steer.mts";

test("steer sends consult/steer to the Job's Broker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running", profile: "codex" });
  const client = new FakeBrokerClient({ ok: true, jobId: "job-running" });
  let connectArgs: Record<string, unknown> | undefined;

  const result = await runSteer({
    args: { positional: ["job-running", "skip", "the", "migration"], flags: {} },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async (args) => {
        connectArgs = args as unknown as Record<string, unknown>;
        return { client: client as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "steered job-running\n");
  assert.equal(connectArgs?.jobId, "job-running");
  assert.equal(connectArgs?.profile, "codex");
  assert.equal(connectArgs?.hostSessionId, "claude-1");
  assert.deepEqual(client.requests, [
    { method: "consult/steer", params: { jobId: "job-running", guidance: "skip the migration" } },
  ]);
  assert.equal(client.closed, true);
});

test("steer accepts guidance from --message", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running" });
  const client = new FakeBrokerClient({ ok: true });

  const result = await runSteer({
    args: { positional: ["job-running"], flags: { message: "prefer the existing helper" } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => ({ client: client as never }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(client.requests, [
    {
      method: "consult/steer",
      params: { jobId: "job-running", guidance: "prefer the existing helper" },
    },
  ]);
});

// Guidance belongs to the running window for the same reason a report does:
// outside it there is no turn to steer (ADR-0039's exit-5 family).
test("steer exits 5 for a Job that is not running", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-queued", status: "queued" });
  await writeJob(workspaceRoot, { jobId: "job-done", status: "completed" });

  const queued = await runSteer({
    args: { positional: ["job-queued", "later"], flags: {} },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be dialed");
      },
    },
  });
  const finalized = await runSteer({
    args: { positional: ["job-done", "too late"], flags: {} },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be dialed");
      },
    },
  });

  assert.equal(queued.exitCode, 5);
  assert.match(queued.stderr, /job not running yet; cannot steer \(status=queued\)/u);
  assert.equal(finalized.exitCode, 5);
  assert.match(finalized.stderr, /job already finalized; cannot steer \(status=completed\)/u);
});

// A foreground delegate and an --isolated background Job both run their turn
// in the companion process, so no other process can reach the prompt turn.
test("steer refuses an inline-runner Job without dialing a Broker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-inline",
    status: "running",
    runner: "inline",
    runnerPid: 4242,
  });

  const result = await runSteer({
    args: { positional: ["job-inline", "go left"], flags: {} },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        throw new Error("broker should not be dialed");
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /steer is not available for job job-inline \(inline runner\)/u);
  assert.match(result.stderr, /cancel and re-delegate/u);
});

test("steer maps Broker refusals onto the exit-code contract", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running" });

  const results: Record<string, { exitCode: number; stderr: string }> = {};
  for (const code of ["STEER_PENDING", "STEER_UNSUPPORTED", "JOB_NOT_RUNNING", "BROKER_TAINTED"]) {
    results[code] = await runSteer({
      args: { positional: ["job-running", "guidance"], flags: {} },
      env: {},
      deps: {
        resolveWorkspaceRoot: async () => workspaceRoot,
        connectBrokerSession: async () => ({
          client: new RejectingBrokerClient(code, `${code} happened`) as never,
        }),
      },
    });
  }

  // A pending steer is contention, retryable like BROKER_BUSY.
  assert.equal(results.STEER_PENDING.exitCode, 3);
  assert.match(results.STEER_PENDING.stderr, /STEER_PENDING: STEER_PENDING happened/u);
  // A capability refusal is never retryable; it matches RESUME_UNSUPPORTED's 1.
  assert.equal(results.STEER_UNSUPPORTED.exitCode, 1);
  assert.equal(results.JOB_NOT_RUNNING.exitCode, 5);
  assert.equal(results.BROKER_TAINTED.exitCode, 3);
});

test("steer surfaces an unreachable Broker with the standard remediation", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running" });

  const result = await runSteer({
    args: { positional: ["job-running", "guidance"], flags: {} },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      connectBrokerSession: async () => {
        const error = new Error("broker is unreachable") as Error & { code: string };
        error.code = "BROKER_UNREACHABLE";
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /BROKER_UNREACHABLE: broker is unreachable/u);
  assert.match(result.stderr, /consult brokers --cleanup/u);
});

test("steer exits 2 for usage errors, an unknown Job, and oversized guidance", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-running", status: "running" });
  const deps = {
    resolveWorkspaceRoot: async () => workspaceRoot,
    connectBrokerSession: async () => {
      throw new Error("broker should not be dialed");
    },
  };

  const missingJob = await runSteer({ args: { positional: [], flags: {} }, env: {}, deps });
  const missingGuidance = await runSteer({
    args: { positional: ["job-running"], flags: {} },
    env: {},
    deps,
  });
  const unknownJob = await runSteer({
    args: { positional: ["job-missing", "guidance"], flags: {} },
    env: {},
    deps,
  });
  const unknownFlag = await runSteer({
    args: { positional: ["job-running", "guidance"], flags: { json: true } },
    env: {},
    deps,
  });
  // Rejected rather than trimmed: a clipped instruction changes the task.
  const oversized = await runSteer({
    args: {
      positional: ["job-running"],
      flags: { message: "x".repeat(MAX_STEER_GUIDANCE_BYTES + 1) },
    },
    env: {},
    deps,
  });

  assert.equal(missingJob.exitCode, 2);
  assert.match(missingJob.stderr, /job id is required/u);
  assert.equal(missingGuidance.exitCode, 2);
  assert.match(missingGuidance.stderr, /guidance is required/u);
  assert.equal(unknownJob.exitCode, 2);
  assert.match(unknownJob.stderr, /job not found: job-missing/u);
  assert.equal(unknownFlag.exitCode, 2);
  assert.equal(oversized.exitCode, 2);
  assert.match(
    oversized.stderr,
    new RegExp(`guidance is \\d+ bytes; the limit is ${MAX_STEER_GUIDANCE_BYTES}`, "u"),
  );
});

test("steer requires host identity in the Job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "job-headless.json"),
    JSON.stringify({ jobId: "job-headless", status: "running", profile: "codex" }),
  );

  const result = await runSteer({
    args: { positional: ["job-headless", "guidance"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /missing host identity/u);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-steer-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

function withDataDir(t: TestContext, dataDir: string): void {
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

async function writeJob(workspaceRoot: string, record: Record<string, unknown>): Promise<void> {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record.jobId}.json`),
    JSON.stringify({ host: "claude-code", hostSessionId: "claude-1", ...record }),
  );
}

class FakeBrokerClient {
  response: unknown;
  closed = false;
  requests: Array<{ method: string; params: unknown }> = [];

  constructor(response: unknown) {
    this.response = response;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.response;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class RejectingBrokerClient {
  code: string;
  message: string;

  constructor(code: string, message: string) {
    this.code = code;
    this.message = message;
  }

  async request(): Promise<unknown> {
    const error = new Error(this.message) as Error & { code: string };
    error.code = this.code;
    throw error;
  }

  async close(): Promise<void> {}
}
