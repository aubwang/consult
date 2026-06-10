import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { runTaskWorker } from "./task-worker.mts";

test("task-worker runs a queued delegate job and finalizes its record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-worker",
    kind: "delegate",
    status: "queued",
    submittedAt: "2026-05-14T10:00:00.000Z",
    mode: "write",
    host: "claude-code",
    profile: "codex",
    prompt: "background prompt",
    hostSessionId: "claude-1",
  });
  const client = new FakeBrokerClient();

  const resultPromise = runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-worker" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: fixedClock(["2026-05-14T10:00:01.000Z", "2026-05-14T10:00:02.000Z"]),
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("done"));
  client.notify("consult/finalized", {
    jobId: "job-worker",
    stopReason: "end_turn",
    sessionId: "session-worker",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(request.params.prompt, "background prompt");
  const record = await readJob(workspaceRoot, "job-worker");
  assert.equal(record.workerPid, process.pid);
  assert.equal(record.status, "completed");
  assert.equal(record.sessionId, "session-worker");
  assert.equal(record.finalText, "done");
});

test("task-worker exits 2 with a clear message for missing or invalid job records", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const missingResult = await runTaskWorker({
    args: { positional: [], flags: { "job-id": "missing" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched");
      },
    }),
  });

  assert.equal(missingResult.exitCode, 2);
  assert.match(missingResult.stderr, /job record not found: missing/);

  const malformedPath = await writeMalformedJob(workspaceRoot, "job-malformed");
  const malformedResult = await runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-malformed" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched");
      },
    }),
  });

  assert.equal(malformedResult.exitCode, 2);
  assert.equal(malformedResult.stderr, `job record malformed: ${malformedPath}\n`);

  await writeJob(workspaceRoot, { jobId: "job-invalid", status: "queued" });
  const invalidResult = await runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-invalid" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched");
      },
    }),
  });

  assert.equal(invalidResult.exitCode, 2);
  assert.match(invalidResult.stderr, /invalid job record job-invalid: missing prompt/);
});

test("task-worker exits 2 when profiles are malformed", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-worker",
    kind: "delegate",
    status: "queued",
    submittedAt: "2026-05-14T10:00:00.000Z",
    mode: "write",
    host: "claude-code",
    profile: "codex",
    prompt: "background prompt",
    hostSessionId: "claude-1",
  });

  const result = await runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-worker" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => {
        const error = Object.assign(new Error("Profiles file is malformed"), {
          code: "PROFILES_MALFORMED",
          path: "/tmp/profiles.json",
        });
        throw error;
      },
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "profiles malformed: /tmp/profiles.json\n");
});

test("task-worker marks the job failed when the broker is busy at start", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-busy",
    kind: "delegate",
    status: "queued",
    submittedAt: "2026-05-14T10:00:00.000Z",
    mode: "write",
    host: "claude-code",
    profile: "codex",
    prompt: "background prompt",
    hostSessionId: "claude-1",
  });
  const client = new FakeBrokerClient();
  client.rejectRequest(
    Object.assign(new Error("broker already has an in-flight prompt turn"), {
      code: "BROKER_BUSY",
    }),
  );

  const result = await runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-busy" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: () => "2026-05-14T10:00:03.000Z",
    }),
  });

  const record = await readJob(workspaceRoot, "job-busy");
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /BROKER_BUSY/);
  assert.equal(record.status, "failed");
  assert.equal(record.completedAt, "2026-05-14T10:00:03.000Z");
  assert.match(record.errorMessage as string, /BROKER_BUSY/);
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-task-worker-"));
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

async function writeJob(workspaceRoot: string, record: Record<string, string>) {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.jobId}.json`), JSON.stringify(record));
}

async function writeMalformedJob(workspaceRoot: string, jobId: string) {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");
  return recordPath;
}

async function readJob(workspaceRoot: string, jobId: string) {
  return JSON.parse(await fs.readFile(path.join(jobsDir(workspaceRoot), `${jobId}.json`), "utf8")) as Record<string, unknown>;
}

function quietDeps(deps: Record<string, unknown>) {
  return {
    ...deps,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  };
}

interface RequestRecord {
  method: string;
  params: Record<string, unknown>;
}

class FakeBrokerClient {
  #handlers = new Map<string, (params: unknown) => void>();
  #requests = new Map<string, RequestRecord>();
  #requestResolvers = new Map<string, (req: RequestRecord) => void>();
  #requestError: Error | null = null;

  on(method: string, handler: (params: unknown) => void) {
    this.#handlers.set(method, handler);
  }

  async request(method: string, params: Record<string, unknown>) {
    const req: RequestRecord = { method, params };
    this.#requests.set(method, req);
    this.#requestResolvers.get(method)?.(req);
    if (this.#requestError) {
      throw this.#requestError;
    }
    return { accepted: true, jobId: params.jobId };
  }

  notify(method: string, params: unknown) {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method: string): Promise<RequestRecord> {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method) as RequestRecord);
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }

  rejectRequest(error: Error) {
    this.#requestError = error;
  }
}

function profilesFixture() {
  return {
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/bin/codex-acp",
        args: [] as string[],
        env: {} as Record<string, string>,
        installedAt: "2026-05-14T09:00:00.000Z",
      },
    },
  };
}

function fixedClock(values: string[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function agentTextUpdate(text: string) {
  return {
    jobId: "job-worker",
    sessionId: "session-worker",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}
