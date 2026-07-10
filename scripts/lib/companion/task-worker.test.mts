import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import type {
  FinalizedIsolatedWorkspace,
  PreparedIsolatedWorkspace,
} from "../isolated-workspace.mts";
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

test("task-worker runs isolated background jobs inline and persists artifacts", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const prepared = isolatedFixture(workspaceRoot, "job-worker-isolated");
  await writeJob(workspaceRoot, {
    jobId: "job-worker-isolated",
    kind: "delegate",
    status: "queued",
    submittedAt: "2026-05-14T10:00:00.000Z",
    mode: "write",
    host: "terminal",
    profile: "codex",
    prompt: "background isolated prompt",
    hostSessionId: "terminal-1",
    isolated: true,
    allowExecute: true,
    isolatedWorkspace: prepared,
  });
  const client = new FakeBrokerClient();
  let ensureInput: Record<string, unknown> | undefined;
  let cleanupCalls = 0;

  const resultPromise = runTaskWorker({
    args: { positional: [], flags: { "job-id": "job-worker-isolated" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async (input: Record<string, unknown>) => {
        ensureInput = input;
        return { client };
      },
      finalizeIsolatedWorkspace: async () => finalizedIsolation(prepared),
      cleanupIsolatedWorkspace: async () => {
        cleanupCalls += 1;
        return {};
      },
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-worker-isolated",
    stopReason: "end_turn",
    sessionId: "session-worker-isolated",
  });
  const result = await resultPromise;
  const record = await readJob(workspaceRoot, "job-worker-isolated");

  assert.equal(result.exitCode, 0);
  assert.equal(ensureInput?.workspaceRoot, workspaceRoot);
  assert.equal(ensureInput?.executionRoot, prepared.executionRoot);
  assert.equal(request.params.allowExecute, true);
  assert.equal(record.runner, "inline");
  assert.equal(record.runnerPid, process.pid);
  assert.equal(typeof record.runnerStartTime, "string");
  assert.equal(record.patchPath, `${prepared.artifactsDir}/changes.patch`);
  assert.deepEqual(record.touchedFiles, ["src/changed.mts"]);
  assert.equal(cleanupCalls, 1);
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

async function writeJob(workspaceRoot: string, record: Record<string, unknown>) {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.jobId}.json`), JSON.stringify(record));
}

function isolatedFixture(workspaceRoot: string, jobId: string): PreparedIsolatedWorkspace {
  const transactionRoot = path.join(path.dirname(workspaceRoot), "data", "isolated-jobs", jobId);
  const artifactsDir = path.join(transactionRoot, "artifacts");
  return {
    schemaVersion: 1,
    jobId,
    workspaceRoot,
    executionRoot: path.join(transactionRoot, "worktree"),
    transactionRoot,
    artifactsDir,
    cleanupMetadataPath: path.join(artifactsDir, "cleanup.json"),
    headCommit: "a".repeat(40),
    baselineTree: "b".repeat(40),
    preparedAt: "2026-07-09T10:00:00.000Z",
    maxBufferBytes: 1024,
    seeded: { stagedPatchBytes: 0, unstagedPatchBytes: 0, untrackedFiles: [] },
  };
}

function finalizedIsolation(
  prepared: PreparedIsolatedWorkspace,
): FinalizedIsolatedWorkspace {
  return {
    schemaVersion: 1,
    jobId: prepared.jobId,
    workspaceRoot: prepared.workspaceRoot,
    executionRoot: prepared.executionRoot,
    baselineTree: prepared.baselineTree,
    patchPath: `${prepared.artifactsDir}/changes.patch`,
    patchBytes: 123,
    touchedFilesPath: `${prepared.artifactsDir}/touched-files.json`,
    touchedFiles: ["src/changed.mts"],
    cleanupMetadataPath: prepared.cleanupMetadataPath,
    finalizedAt: "2026-07-09T10:01:00.000Z",
  };
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
