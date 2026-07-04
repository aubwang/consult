import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import { runLogs } from "./logs.mts";

test("logs prints rendered text from a stored job log", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-log", status: "completed" });
  await writeLog(workspaceRoot, "job-log", [
    updateText("hello "),
    updateText("world"),
    {
      method: "consult/update",
      params: {
        jobId: "job-log",
        update: { sessionUpdate: "tool_call", kind: "shell", title: "test" },
      },
    },
  ]);

  const result = await runLogs({
    args: { positional: ["job-log"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello world[tool_call shell: test]\n");
  assert.equal(result.stderr, "");
});

test("logs json mode prints parsed log entries for non-following reads", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-json", status: "completed" });
  await writeLog(workspaceRoot, "job-json", [updateText("one"), updateText("two")]);

  const result = await runLogs({
    args: { positional: ["job-json"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [updateText("one"), updateText("two")]);
});

test("logs follow appends newly rendered log text until the job finalizes", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-follow", status: "running" });
  await writeLog(workspaceRoot, "job-follow", [updateText("first")]);
  const streamed: string[] = [];
  let polls = 0;

  const result = await runLogs({
    args: { positional: ["job-follow"], flags: { follow: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text) => streamed.push(text),
      poll: async () => {
        polls += 1;
        await appendLog(workspaceRoot, "job-follow", [updateText(" second")]);
        await writeJob(workspaceRoot, { jobId: "job-follow", status: "completed" });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(polls, 1);
  // Follow mode streams through the writer and returns empty stdout so the
  // CLI entrypoint does not print the streamed text a second time.
  assert.equal(result.stdout, "");
  assert.deepEqual(streamed, ["first", " second"]);
});

test("logs follow skips a partially flushed trailing line and picks it up later", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-partial", status: "running" });
  const fullLine = JSON.stringify(updateText("first"));
  const secondLine = JSON.stringify(updateText(" second"));
  await writeRawLog(workspaceRoot, "job-partial", `${fullLine}\n${secondLine.slice(0, 10)}`);
  const streamed: string[] = [];
  let polls = 0;

  const result = await runLogs({
    args: { positional: ["job-partial"], flags: { follow: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text) => streamed.push(text),
      stderrWrite: () => {},
      poll: async () => {
        polls += 1;
        await writeRawLog(workspaceRoot, "job-partial", `${fullLine}\n${secondLine}\n`);
        await writeJob(workspaceRoot, { jobId: "job-partial", status: "completed" });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(polls, 1);
  assert.equal(streamed.filter((chunk) => chunk !== "").join(""), "first second");
});

test("logs follow times out when the job does not finalize", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-timeout", status: "running" });
  const streamedErrors: string[] = [];
  let now = 0;

  const result = await runLogs({
    args: { positional: ["job-timeout"], flags: { follow: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: () => {},
      stderrWrite: (text) => streamedErrors.push(text),
      maxWaitMs: 1,
      nowMs: () => now,
      poll: async () => {
        now += 2;
      },
    },
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, "");
  assert.match(streamedErrors.join(""), /timed out following job job-timeout/);
});

test("logs exits 2 for an unknown job id", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runLogs({
    args: { positional: ["missing"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "job not found: missing\n");
});

test("logs exits 2 for malformed NDJSON", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-bad", status: "completed" });
  const logPath = await writeRawLog(workspaceRoot, "job-bad", `${JSON.stringify(updateText("ok"))}\n{\n`);

  const result = await runLogs({
    args: { positional: ["job-bad"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job log malformed: ${logPath}:2\n`);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-logs-"));
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
  await fs.writeFile(path.join(dir, `${record.jobId}.json`), JSON.stringify(record));
}

async function writeLog(
  workspaceRoot: string,
  jobId: string,
  entries: unknown[],
): Promise<string> {
  return await writeRawLog(
    workspaceRoot,
    jobId,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function appendLog(
  workspaceRoot: string,
  jobId: string,
  entries: unknown[],
): Promise<void> {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, `${jobId}.log`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function writeRawLog(
  workspaceRoot: string,
  jobId: string,
  content: string,
): Promise<string> {
  const dir = logsDir(workspaceRoot);
  const logPath = path.join(dir, `${jobId}.log`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(logPath, content, "utf8");
  return logPath;
}

function updateText(text: string): Record<string, unknown> {
  return {
    method: "consult/update",
    params: {
      jobId: "job-log",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}
