import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import { runStatus } from "./status.mts";

test("status lists an empty table when there are no jobs", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runStatus({
    args: { positional: [], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /jobId/);
  assert.match(result.stdout, /\(no jobs\)/);
});

test("status lists all jobs newest first", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-old",
    profile: "codex",
    status: "completed",
    submittedAt: "2026-05-14T09:00:00.000Z",
    completedAt: "2026-05-14T09:01:00.000Z",
    prompt: "old prompt",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-new",
    profile: "claude",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
    prompt: "new prompt",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-mid",
    profile: "opencode",
    status: "failed",
    submittedAt: "2026-05-14T09:30:00.000Z",
    completedAt: "2026-05-14T09:31:00.000Z",
    prompt: "mid prompt",
  });

  const result = await runStatus({
    args: { positional: [], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /job-old/);
  assert.match(result.stdout, /job-mid/);
  assert.match(result.stdout, /job-new/);
  assert.equal(result.stdout.indexOf("job-new") < result.stdout.indexOf("job-mid"), true);
  assert.equal(result.stdout.indexOf("job-mid") < result.stdout.indexOf("job-old"), true);
  assert.match(result.stdout, /job-new\tclaude\trunning\t-\t-\t-/);
});

test("status table shows parent and child relationships", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-root",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
    chainId: "job-root",
    parentJobId: null,
    delegationDepth: 0,
    prompt: "root prompt",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-child",
    profile: "claude",
    status: "queued",
    submittedAt: "2026-05-14T10:01:00.000Z",
    chainId: "job-root",
    parentJobId: "job-root",
    delegationDepth: 1,
    prompt: "child prompt",
  });

  const result = await runStatus({
    args: { positional: [], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /depth\tparentJobId\tchildren/);
  assert.match(result.stdout, /job-root\tcodex\trunning\t0\t-\tjob-child/);
  assert.match(result.stdout, /job-child\tclaude\tqueued\t1\tjob-root\t-/);
});

test("status prints one job as pretty JSON with a log tail", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-one",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
    prompt: "inspect logs",
  });
  await writeLog(workspaceRoot, "job-one", Array.from({ length: 25 }, (_, index) => `line-${index}`));

  const result = await runStatus({
    args: { positional: ["job-one"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"jobId": "job-one"/);
  assert.match(result.stdout, /"childJobIds": \[\]/);
  assert.match(result.stdout, /log tail/);
  assert.doesNotMatch(result.stdout, /line-4/);
  assert.match(result.stdout, /line-5/);
  assert.match(result.stdout, /line-24/);
});

test("status one-job mode includes direct child job ids", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-parent",
    profile: "codex",
    status: "completed",
    submittedAt: "2026-05-14T10:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-child",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:01:00.000Z",
    parentJobId: "job-parent",
  });

  const result = await runStatus({
    args: { positional: ["job-parent"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.job.id, "job-parent");
  assert.deepEqual(envelope.lineage.childJobIds, ["job-child"]);
  assert.deepEqual(envelope.logTail, []);
});

test("status json list mode emits one array line", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-json",
    profile: "codex",
    status: "completed",
    submittedAt: "2026-05-14T10:00:00.000Z",
    completedAt: "2026-05-14T10:01:00.000Z",
  });

  const result = await runStatus({
    args: { positional: [], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(
    (envelope.jobs as Array<{ job: { id: string } }>).map((record) => record.job.id),
    ["job-json"],
  );
  assert.equal(envelope.jobs[0].job.status, "completed");
  assert.deepEqual(envelope.jobs[0].artifacts.touchedFiles, []);
});

test("status wait exits with final state after polling a job to completion", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-wait",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
    prompt: "wait",
  });
  let polls = 0;

  const result = await runStatus({
    args: { positional: ["job-wait"], flags: { wait: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      poll: async () => {
        polls += 1;
        await writeJob(workspaceRoot, {
          jobId: "job-wait",
          profile: "codex",
          status: "completed",
          submittedAt: "2026-05-14T10:00:00.000Z",
          completedAt: "2026-05-14T10:01:00.000Z",
          finalText: "done",
        });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(polls, 1);
  assert.match(result.stdout, /"status": "completed"/);
});

test("status follow streams rendered logs until the job finalizes", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-follow",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
  });
  await writeLog(workspaceRoot, "job-follow", [
    JSON.stringify({
      method: "consult/update",
      params: {
        jobId: "job-follow",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
    }),
  ]);
  let polls = 0;
  const streamed: string[] = [];

  const result = await runStatus({
    args: { positional: ["job-follow"], flags: { follow: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text: string) => streamed.push(text),
      poll: async () => {
        polls += 1;
        await writeLog(workspaceRoot, "job-follow", [
          JSON.stringify({
            method: "consult/update",
            params: {
              jobId: "job-follow",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "first" },
              },
            },
          }),
          JSON.stringify({
            method: "consult/update",
            params: {
              jobId: "job-follow",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: " second" },
              },
            },
          }),
        ]);
        await writeJob(workspaceRoot, {
          jobId: "job-follow",
          profile: "codex",
          status: "completed",
          submittedAt: "2026-05-14T10:00:00.000Z",
          completedAt: "2026-05-14T10:01:00.000Z",
        });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(polls, 1);
  // status --follow streams through the writer and returns empty stdout.
  assert.equal(result.stdout, "");
  assert.equal(streamed.join(""), "first second");
});

test("status wait exits 4 when the job never finishes before timeout", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-timeout",
    profile: "codex",
    status: "running",
    submittedAt: "2026-05-14T10:00:00.000Z",
  });

  const result = await runStatus({
    args: { positional: ["job-timeout"], flags: { wait: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      maxWaitMs: 50,
      poll: async (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25))),
    },
  });

  assert.equal(result.exitCode, 4);
  assert.match(result.stderr, /timed out waiting for job job-timeout/);
});

test("status exits 2 for an unknown job id", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runStatus({
    args: { positional: ["missing"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /job not found: missing/);
});

test("status exits 2 for a malformed job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = await writeMalformedJob(workspaceRoot, "job-bad");

  const result = await runStatus({
    args: { positional: ["job-bad"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

test("status list exits 2 for a non-object job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = await writeRawJob(workspaceRoot, "job-bad", "null");

  const result = await runStatus({
    args: { positional: [], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-status-"));
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

async function writeJob(workspaceRoot: string, record: Record<string, unknown>): Promise<void> {
  const dir = jobsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.jobId}.json`), JSON.stringify(record));
}

async function writeMalformedJob(workspaceRoot: string, jobId: string): Promise<string> {
  return await writeRawJob(workspaceRoot, jobId, "{");
}

async function writeRawJob(workspaceRoot: string, jobId: string, content: string): Promise<string> {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, content, "utf8");
  return recordPath;
}

async function writeLog(workspaceRoot: string, jobId: string, lines: string[]): Promise<void> {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${jobId}.log`), `${lines.join("\n")}\n`);
}
