import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { brokersDir, jobsDir } from "./broker-endpoint.mts";
import { jobLogPath } from "./job-records.mts";
import type { JobRecord } from "./job-records.mts";
import { runCancel } from "./companion/cancel.mts";
import { runDelegateOnce } from "./companion/delegate-core.mts";

const fakeAgentPath = fileURLToPath(
  new URL("./__fixtures__/fake-acp-agent.mts", import.meta.url),
);
const companionPath = fileURLToPath(new URL("../consult-companion.mts", import.meta.url));

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

test("inline runner resumes an existing session via session/resume", async (t) => {
  const { workspaceRoot, dataDir, dir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const methodLog = path.join(dir, "methods.ndjson");
  const jobRecord = queuedJobRecord("job-inline-resume", { resumeSessionId: "sess-resumed" });

  const result = await runDelegateOnce({
    workspaceRoot,
    profileEntry: profileEntryFixture("default", {
      CONSULT_FAKE_AGENT_METHOD_LOG: methodLog,
    }),
    jobRecord,
    prompt: "continue",
    resumeSessionId: "sess-resumed",
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

test("foreground delegate through the CLI completes without broker state", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles(dataDir, "prompt-updates");
  const child = spawnForegroundDelegate(t, workspaceRoot, dataDir, ["--json"]);
  const stdout = collectChildStdout(child);
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

  assert.equal(code, 0);
  const summary = JSON.parse(stdout.text().trim().split("\n").at(-1)!) as Record<string, unknown>;
  assert.equal(summary.status, "completed");
  const record = await readJobRecordFile(workspaceRoot, summary.jobId as string);
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
    [companionPath, "delegate", ...extraArgs, "--", "delegated prompt"],
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
