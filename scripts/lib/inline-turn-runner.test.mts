import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import { brokersDir, jobsDir } from "./broker-endpoint.mts";
import type { StartedAgent } from "./acp-client.mts";
import { jobLogPath } from "./job-records.mts";
import type { JobRecord } from "./job-records.mts";
import { runCancel } from "./companion/cancel.mts";
import { runDelegateOnce } from "./companion/delegate-core.mts";
import { createInlineClient } from "./inline-turn-runner.mts";
import {
  JOB_LOG_LIMIT_EXCEEDED,
  JOB_WALL_CLOCK_LIMIT_EXCEEDED,
  jobLimitErrorMessage,
  jobLogLineBytes,
} from "./job-reliability.mts";

const fakeAgentPath = fileURLToPath(
  new URL("./__fixtures__/fake-acp-agent.mts", import.meta.url),
);
const companionPath = fileURLToPath(new URL("../consult-companion.mts", import.meta.url));
const execFileAsync = promisify(execFile);

test("inline runner completes a turn with records and logs and no broker state", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const jobRecord = queuedJobRecord("job-inline-happy");

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("prompt-updates"),
    jobRecord,
    prompt: "hello",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /firstsecond/);
  assert.match(result.stdout, /consult delegate job-inline-happy completed/);

  const record = await readJobRecordFile(workspaceRoot, "job-inline-happy");
  assert.equal(record.status, "completed");
  assert.equal(record.sessionId, "sess-1");
  assert.equal(record.stopReason, "end_turn");
  assert.equal(record.finalText, "firstsecond");
  assert.equal(record.runner, "inline");
  assert.equal(record.runnerPid, process.pid);

  const logEntries = await readLogEntries(workspaceRoot, "job-inline-happy");
  assert.equal(logEntries.length, 3);
  assert.deepEqual(
    logEntries.map((entry) => entry.method),
    ["consult/update", "consult/update", "consult/finalized"],
  );
  assert.equal((logEntries[2].params as { stopReason?: string }).stopReason, "end_turn");

  // The point of the inline runner: no broker locator, pidfile, or endpoint
  // state is ever created for a foreground job.
  await assert.rejects(fs.readdir(brokersDir(workspaceRoot)), { code: "ENOENT" });
});

test("inline runner finalizes a read-only policy violation as failed and exits 6", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const jobRecord = queuedJobRecord("job-inline-violation");

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("prompt-auto-approved-edit"),
    jobRecord,
    prompt: "edit something",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 6);
  const record = await readJobRecordFile(workspaceRoot, "job-inline-violation");
  assert.equal(record.status, "failed");
  assert.match(
    record.errorMessage as string,
    /policy violation: auto-approved edit update in read-only mode/,
  );
});

test("inline runner rejects stale canonical authority before Profile launch", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const beforeSigintListeners = process.listenerCount("SIGINT");
  const client = createInlineClient({
    workspaceRoot,
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    authority: authority(),
    profileEntry: profileEntryFixture("exit"),
  });

  await assert.rejects(
    client.request("consult/run", {
      jobId: "job-inline-stale-authority",
      prompt: "hello",
      profile: "codex",
      authority: authority({ mode: "write" }),
      mode: "write",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_MISMATCH");
      return true;
    },
  );
  assert.equal(process.listenerCount("SIGINT"), beforeSigintListeners);
});

test("inline preflight preserves the original error when agent disposal rejects", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = createInlineClient({
    workspaceRoot,
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    authority: authority(),
    profileEntry: profileEntryFixture("exit"),
    startAgent: async () => ({
      connection: {},
      capabilities: {},
      dispose: async () => { throw new Error("dispose failed"); },
    } as unknown as StartedAgent),
  });

  await assert.rejects(
    client.request("consult/run", {
      jobId: "job-inline-dispose-preflight",
      prompt: "resume",
      profile: "codex",
      authority: authority(),
      resume: "session-1",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RESUME_UNSUPPORTED");
      assert.doesNotMatch((error as Error).message, /dispose failed/u);
      return true;
    },
  );
});

test("inline async failure contains a rejecting agent disposal", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = createInlineClient({
    workspaceRoot,
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    authority: authority(),
    profileEntry: profileEntryFixture("exit"),
    startAgent: async () => ({
      connection: {
        newSession: async () => { throw new Error("session failed"); },
      },
      capabilities: {},
      dispose: async () => { throw new Error("dispose failed"); },
    } as unknown as StartedAgent),
  });
  const finalized = new Promise<any>((resolve) => client.on("consult/finalized", resolve));

  await client.request("consult/run", {
    jobId: "job-inline-dispose-async",
    prompt: "run",
    profile: "codex",
    authority: authority(),
  });

  const notification = await finalized;
  assert.equal(notification.stopReason, "failed");
  assert.match(notification.errorMessage, /PROFILE_CLEANUP_UNCONFIRMED: dispose failed/u);
  await new Promise((resolve) => setImmediate(resolve));
});

test("inline wall-clock limit cancels and disposes the Profile before finalizing failed", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const cancelLog = path.join(dir, "limit-cancel.ndjson");
  const inheritedAuthority = authority({ confinement: "inherit" });
  let wallClockHandler: (() => void) | undefined;
  const timer = { unref() {} } as unknown as NodeJS.Timeout;
  const client = createInlineClient({
    workspaceRoot,
    host: "terminal",
    hostSessionId: "default",
    profile: "codex",
    authority: inheritedAuthority,
    profileEntry: profileEntryFixture("prompt-cancel-ack", {
      CONSULT_FAKE_AGENT_CANCEL_LOG: cancelLog,
    }),
    maxWallClockMs: 25,
    scheduleWallClock(handler, milliseconds) {
      assert.equal(milliseconds, 25);
      wallClockHandler = handler;
      return timer;
    },
    clearWallClock() {},
  });
  let updateResolve!: () => void;
  const sawUpdate = new Promise<void>((resolve) => {
    updateResolve = resolve;
  });
  client.on("consult/update", () => updateResolve());
  const finalized = new Promise<any>((resolve) => client.on("consult/finalized", resolve));

  await client.request("consult/run", {
    jobId: "job-inline-wall-limit",
    prompt: "keep working",
    profile: "codex",
    authority: inheritedAuthority,
    mode: "read-only",
  });
  await sawUpdate;
  assert.ok(wallClockHandler);
  wallClockHandler!();

  const notification = await finalized;
  assert.equal(notification.stopReason, "failed");
  assert.match(notification.errorMessage, new RegExp(`^${JOB_WALL_CLOCK_LIMIT_EXCEEDED}:`));
  const record = await readJobRecordFile(workspaceRoot, "job-inline-wall-limit");
  assert.equal(record.status, "failed");
  assert.equal(record.finalText, "slow");
  assert.match(record.errorMessage ?? "", new RegExp(`^${JOB_WALL_CLOCK_LIMIT_EXCEEDED}:`));
  assert.deepEqual(await readNdjson(cancelLog), [{ sessionId: "sess-1" }]);
});

test("inline log limit keeps persisted NDJSON bounded and finalizes with a stable diagnostic", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const jobId = "job-inline-log-limit";
  const maxPersistedLogBytes = 256;
  const terminalParams = {
    jobId,
    stopReason: "failed",
    sessionId: null,
    errorMessage: jobLimitErrorMessage(JOB_LOG_LIMIT_EXCEEDED, maxPersistedLogBytes),
  };
  const updateParams = {
    jobId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "slow" },
    },
  };
  assert.ok(jobLogLineBytes("consult/finalized", terminalParams) <= maxPersistedLogBytes);
  assert.ok(
    jobLogLineBytes("consult/finalized", terminalParams) +
      jobLogLineBytes("consult/update", updateParams) >
      maxPersistedLogBytes,
  );
  const cancelLog = path.join(dir, "log-limit-cancel.ndjson");
  const jobRecord = queuedJobRecord(jobId);

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("prompt-cancel-ack", {
      CONSULT_FAKE_AGENT_CANCEL_LOG: cancelLog,
    }),
    jobRecord,
    prompt: "keep writing",
    inline: true,
    deps: {
      ensureBrokerSession: async (input) => ({
        client: createInlineClient({
          ...input,
          maxPersistedLogBytes,
        }),
      }),
    },
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 6);
  const record = await readJobRecordFile(workspaceRoot, jobId);
  assert.equal(record.status, "failed");
  assert.equal(record.finalText, "");
  assert.match(record.errorMessage ?? "", new RegExp(`^${JOB_LOG_LIMIT_EXCEEDED}:`));
  const logStat = await fs.stat(jobLogPath(workspaceRoot, jobId));
  assert.ok(logStat.size <= maxPersistedLogBytes);
  const entries = await readLogEntries(workspaceRoot, jobId);
  assert.deepEqual(entries.map((entry) => entry.method), ["consult/finalized"]);
  assert.deepEqual(await readNdjson(cancelLog), [{ sessionId: "sess-1" }]);
});

test("inline runner applies model and effort before prompting", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const methodLog = path.join(dir, "methods.ndjson");
  const jobRecord = queuedJobRecord("job-inline-controls", { model: "gpt-test", effort: "high" });

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("controls", {
      CONSULT_FAKE_AGENT_METHOD_LOG: methodLog,
    }),
    jobRecord,
    prompt: "hello",
    model: "gpt-test",
    effort: "high",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 0);
  const methods = await readNdjson(methodLog);
  const methodNames = methods.map((entry) => entry.method);
  const setModelIndex = methodNames.indexOf("session/set_model");
  const setEffortIndex = methodNames.indexOf("session/set_config_option");
  const promptIndex = methodNames.indexOf("session/prompt");
  assert.notEqual(setModelIndex, -1);
  assert.notEqual(setEffortIndex, -1);
  assert.ok(setModelIndex < promptIndex);
  assert.ok(setEffortIndex < promptIndex);
  assert.deepEqual(methods[setModelIndex].params, { sessionId: "sess-1", modelId: "gpt-test" });
  assert.deepEqual(methods[setEffortIndex].params, {
    sessionId: "sess-1",
    configId: "thought-level",
    value: "high",
  });
});

test("inline runner injects delegation lineage into the agent environment", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const envLog = path.join(dir, "env.ndjson");
  const jobRecord = queuedJobRecord("job-inline-env");

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("default", {
      CONSULT_FAKE_AGENT_ENV_LOG: envLog,
    }),
    jobRecord,
    prompt: "hello",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 0);
  const [agentEnv] = await readNdjson(envLog);
  assert.equal(agentEnv.CONSULT_PARENT_JOB, "job-inline-env");
  assert.equal(agentEnv.CONSULT_WORKSPACE, workspaceRoot);
});

test("inline runner separates original Job state identity from the Profile execution root", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const executionRoot = path.join(dir, "detached-worktree");
  await fs.mkdir(executionRoot);
  const envLog = path.join(dir, "isolated-env.ndjson");
  const methodLog = path.join(dir, "isolated-methods.ndjson");
  const jobRecord = queuedJobRecord("job-inline-isolated-root", {
    mode: "write",
    isolated: true,
  });

  const result = await runDelegateOnce({
    workspaceRoot,
    executionRoot,
    profileEntry: profileEntryFixture("default", {
      CONSULT_FAKE_AGENT_ENV_LOG: envLog,
      CONSULT_FAKE_AGENT_METHOD_LOG: methodLog,
    }),
    jobRecord,
    prompt: "hello",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 0);
  const [agentEnv] = await readNdjson(envLog);
  const methods = await readNdjson(methodLog);
  assert.equal(agentEnv.CONSULT_WORKSPACE, workspaceRoot);
  assert.equal(
    (methods.find((entry) => entry.method === "session/new")?.params as { cwd?: string }).cwd,
    executionRoot,
  );
  const record = await readJobRecordFile(workspaceRoot, "job-inline-isolated-root");
  assert.equal(record.status, "completed");
});

test("inline runner resumes an existing session via session/resume", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const methodLog = path.join(dir, "methods.ndjson");
  const jobRecord = queuedJobRecord("job-inline-resume", {
    resumeSessionId: "sess-resumed",
    resumeJobId: "job-source",
  });

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("default", {
      CONSULT_FAKE_AGENT_METHOD_LOG: methodLog,
    }),
    jobRecord,
    prompt: "continue",
    resumeSessionId: "sess-resumed",
    resumeJobId: "job-source",
    inline: true,
    output: collectOutput(),
  });

  assert.equal(result.exitCode, 0);
  const methods = await readNdjson(methodLog);
  const resumeEntry = methods.find((entry) => entry.method === "session/resume");
  assert.ok(resumeEntry, "expected a session/resume call");
  assert.equal((resumeEntry.params as { sessionId?: string }).sessionId, "sess-resumed");
  const record = await readJobRecordFile(workspaceRoot, "job-inline-resume");
  assert.equal(record.sessionId, "sess-resumed");
  assert.equal(record.status, "completed");
});

test("SIGTERM cancels an in-flight inline turn and marks the record cancelled", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-cancel-ack");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir);

  await waitForStdout(child, "slow");
  const jobId = await waitForSingleJobId(workspaceRoot);
  child.kill("SIGTERM");
  await once(child, "exit");

  const record = await waitForRecordStatus(workspaceRoot, jobId, "cancelled");
  assert.equal(record.status, "cancelled");
  assert.equal(record.runner, "inline");
  assert.equal(record.runnerPid, child.pid);
});

test("forced SIGTERM cancellation remains cancelled when the agent does not acknowledge", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-cancel-no-ack");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir);

  await waitForStdout(child, "slow");
  const jobId = await waitForSingleJobId(workspaceRoot);
  child.kill("SIGTERM");
  await once(child, "exit");

  const record = await waitForRecordStatus(workspaceRoot, jobId, "cancelled");
  assert.equal(record.status, "cancelled");
  assert.equal(record.stopReason, "cancelled");
  assert.match(
    record.errorMessage as string,
    /cancelled before the agent acknowledged session\/cancel/,
  );
});

test("consult cancel signals a live inline runner and the job settles cancelled", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-cancel-ack");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir);

  await waitForStdout(child, "slow");
  const jobId = await waitForSingleJobId(workspaceRoot);

  const result = await runCancel({
    args: { positional: [jobId], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`inline runner pid ${child.pid} signalled`));
  await once(child, "exit");
  const record = await waitForRecordStatus(workspaceRoot, jobId, "cancelled");
  assert.equal(record.status, "cancelled");
});

test("cancelled isolated inline jobs persist an artifact and remove their worktree", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeGitWorkspace(t);
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-cancel-ack");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir, ["--write", "--isolated"]);

  await waitForStdout(child, "slow");
  const jobId = await waitForSingleJobId(workspaceRoot);
  const runningRecord = await readJobRecordFile(workspaceRoot, jobId);
  const executionRoot = (runningRecord.isolatedWorkspace as { executionRoot: string }).executionRoot;
  child.kill("SIGTERM");
  await once(child, "exit");

  const record = await waitForRecordStatus(workspaceRoot, jobId, "cancelled");
  assert.equal(record.status, "cancelled");
  assert.equal(record.isolated, true);
  assert.deepEqual(record.touchedFiles, []);
  assert.equal(typeof record.patchPath, "string");
  assert.ok(await fs.stat(record.patchPath as string));
  await assert.rejects(fs.access(executionRoot));
  await fs.rm(dir, { recursive: true, force: true });
});

test("foreground delegate through the CLI completes without broker state", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-updates");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir, ["--json"]);
  const stdout = collectChildStdout(child);
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

  assert.equal(code, 0);
  const summary = JSON.parse(stdout.text()) as {
    schemaVersion: number;
    job: { id: string; status: string };
  };
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.job.status, "completed");
  const record = await readJobRecordFile(workspaceRoot, summary.job.id);
  assert.equal(record.status, "completed");
  assert.equal(record.runner, "inline");
  assert.equal(record.runnerPid, child.pid);

  // No broker endpoint locator or pidfile may exist for a foreground job.
  await assert.rejects(fs.readdir(brokersDir(workspaceRoot)), { code: "ENOENT" });
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-inline-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { dir, workspaceRoot: await fs.realpath(workspaceRoot), dataDir };
}

async function makeGitWorkspace(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-inline-isolated-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(workspaceRoot);
  await execFileAsync("git", ["init"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Consult Test"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "consult@example.invalid"], {
    cwd: workspaceRoot,
  });
  await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, workspaceRoot: await fs.realpath(workspaceRoot), dataDir };
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

function withEnv(t: TestContext, name: string, value: string) {
  const original = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  });
}

function queuedJobRecord(jobId: string, overrides: Record<string, unknown> = {}): JobRecord {
  return {
    jobId,
    kind: "delegate",
    status: "queued",
    submittedAt: "2026-07-04T10:00:00.000Z",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "codex",
    mode: "read-only",
    prompt: "hello",
    chainId: jobId,
    parentJobId: null,
    delegationDepth: 0,
    runner: "inline",
    runnerPid: process.pid,
    ...overrides,
  };
}

function authority(
  overrides: Partial<{
    mode: "read-only" | "write";
    confinement: "confined" | "inherit";
    allowFetch: boolean;
    allowExecute: boolean;
  }> = {},
) {
  return {
    schemaVersion: 1 as const,
    mode: "read-only" as const,
    confinement: "confined" as const,
    allowFetch: false,
    allowExecute: false,
    ...overrides,
  };
}

function profileEntryFixture(scenario: string, env: Record<string, string> = {}) {
  return {
    registryId: "codex",
    binary: process.execPath,
    args: [fakeAgentPath, "sessions", scenario],
    env,
    installedAt: "2026-07-04T09:00:00.000Z",
  };
}

async function writeProfiles(dataDir: string, scenario: string) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      default: "codex",
      profiles: { codex: profileEntryFixture(scenario) },
    }),
  );
}

function spawnForegroundDelegate(
  t: TestContext,
  workspaceRoot: string,
  dataDir: string,
  extraArgs: string[] = [],
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      companionPath,
      "delegate",
      "--sandbox",
      "inherit",
      ...extraArgs,
      "--",
      "delegated prompt",
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, CONSULT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  return child;
}

function collectChildStdout(child: ChildProcess) {
  let text = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    text += chunk;
  });
  return { text: () => text };
}

async function waitForStdout(child: ChildProcess, needle: string, timeoutMs = 10_000) {
  let text = "";
  let stderrText = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)} in child stdout`));
    }, timeoutMs);
    child.stdout!.on("data", (chunk: string) => {
      text += chunk;
      if (text.includes(needle)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `child exited (code=${code} signal=${signal}) before printing ${JSON.stringify(
            needle,
          )}; stderr: ${stderrText}`,
        ),
      );
    });
  });
}

async function waitForSingleJobId(workspaceRoot: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(jobsDir(workspaceRoot)).catch(() => [] as string[]);
    const records = entries.filter((entry) => entry.endsWith(".json"));
    if (records.length === 1) {
      return records[0].slice(0, -".json".length);
    }
    await delay(25);
  }
  throw new Error("timed out waiting for the job record to appear");
}

async function waitForRecordStatus(
  workspaceRoot: string,
  jobId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  let record: JobRecord = {};
  while (Date.now() < deadline) {
    record = await readJobRecordFile(workspaceRoot, jobId).catch(() => ({}) as JobRecord);
    if (record.status === status) {
      return record;
    }
    await delay(25);
  }
  return record;
}

async function readJobRecordFile(workspaceRoot: string, jobId: string): Promise<JobRecord> {
  return JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), `${jobId}.json`), "utf8"),
  ) as JobRecord;
}

async function readLogEntries(workspaceRoot: string, jobId: string) {
  return await readNdjson(jobLogPath(workspaceRoot, jobId));
}

async function readNdjson(filePath: string): Promise<Record<string, unknown>[]> {
  const contents = await fs.readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function collectOutput() {
  let stdout = "";
  let stderr = "";
  return {
    stdout(text: string) {
      stdout += text;
    },
    stderr(text: string) {
      stderr += text;
    },
    result(exitCode: number) {
      return { exitCode, stdout, stderr };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
