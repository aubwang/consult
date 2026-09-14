import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { runWait } from "./wait.mts";

test("wait blocks once until all selected Jobs are terminal and returns their Results", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-a",
    status: "running",
    profile: "claude",
    submittedAt: "2026-07-11T10:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-b",
    status: "completed",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:01.000Z",
    completedAt: "2026-07-11T10:00:02.000Z",
    finalText: "B is done.",
  });
  let polls = 0;

  const result = await runWait({
    args: { positional: ["job-a", "job-b"], flags: { json: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      poll: async () => {
        polls += 1;
        await writeJob(workspaceRoot, {
          jobId: "job-a",
          status: "failed",
          profile: "claude",
          submittedAt: "2026-07-11T10:00:00.000Z",
          completedAt: "2026-07-11T10:00:03.000Z",
          errorMessage: "upstream failed",
        });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(polls, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(
    envelope.jobs.map((job: { job: { id: string; status: string } }) => [
      job.job.id,
      job.job.status,
    ]),
    [
      ["job-a", "failed"],
      ["job-b", "completed"],
    ],
  );
  assert.equal(envelope.jobs[0].outcome.errorMessage, "upstream failed");
  assert.equal(envelope.jobs[1].outcome.finalText, "B is done.");
});

test("wait --summary returns bounded one-line outcomes and artifact paths", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-summary",
    label: "parser cleanup",
    status: "completed",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:00.000Z",
    completedAt: "2026-07-11T10:00:01.000Z",
    finalText: `${"detail ".repeat(100)}Implemented the requested change.`,
    patchPath: "/tmp/job-summary.patch",
    touchedFilesPath: "/tmp/job-summary-files.json",
  });

  const result = await runWait({
    args: { positional: ["job-summary"], flags: { summary: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.match(
    result.stdout,
    /^job-summary \[parser cleanup\] completed \| output preview: \.\.\..*Implemented the requested change\./u,
  );
  assert.match(result.stdout, /patch: \/tmp\/job-summary\.patch/u);
  assert.match(result.stdout, /files: \/tmp\/job-summary-files\.json/u);
  assert.ok(result.stdout.length < 400);
  assert.doesNotMatch(result.stdout, /(?:detail ){30}/u);
});

test("wait rejects combining --summary with --json", async () => {
  const result = await runWait({
    args: { positional: ["job-summary"], flags: { summary: true, json: true } },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--summary is not supported with --json\n");
});

test("wait cancels still-active Jobs when the Host interrupts its tool call", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-done",
    status: "completed",
    profile: "claude",
    submittedAt: "2026-07-11T10:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:01.000Z",
  });
  const controller = new AbortController();
  const cancelled: string[] = [];

  const result = await runWait({
    args: { positional: ["job-done", "job-active"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      signal: controller.signal,
      poll: async () => controller.abort(),
      cancelJob: async (_workspaceRoot, jobId) => {
        cancelled.push(jobId);
        return { exitCode: 0, stdout: "cancelled\n", stderr: "" };
      },
    },
  });

  assert.equal(result.exitCode, 130);
  assert.deepEqual(cancelled, ["job-active"]);
  assert.match(result.stderr, /wait interrupted; cancellation requested for job-active/u);
});

test("wait can leave active Jobs running when interrupted explicitly", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:01.000Z",
  });
  const controller = new AbortController();
  let cancelCalls = 0;

  const result = await runWait({
    args: { positional: ["job-active"], flags: { "keep-running": true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      signal: controller.signal,
      poll: async () => controller.abort(),
      cancelJob: async () => {
        cancelCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(result.exitCode, 130);
  assert.equal(cancelCalls, 0);
  assert.equal(result.stderr, "wait interrupted; active Jobs left running\n");
});

test("wait reports cleanup errors without losing the interrupt outcome", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:01.000Z",
  });
  const controller = new AbortController();

  const result = await runWait({
    args: { positional: ["job-active"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      signal: controller.signal,
      poll: async () => controller.abort(),
      cancelJob: async () => {
        throw new Error("cancel transport unavailable");
      },
    },
  });

  assert.equal(result.exitCode, 130);
  assert.match(result.stderr, /cancellation errors: job-active: cancel transport unavailable/u);
});

test("wait times out once for the selected Job set", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-active",
    status: "running",
    profile: "codex",
    submittedAt: "2026-07-11T10:00:01.000Z",
  });

  const result = await runWait({
    args: { positional: ["job-active"], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      maxWaitMs: 0,
      nowMs: () => 0,
    },
  });

  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, "timed out waiting for Jobs: job-active\n");
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-wait-"));
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

test("wait --any watches changes and returns the current state of every selected Job", async () => {
  let polls = 0;
  const output: string[] = [];
  const result = await runWait({ args: { positional: ["job-a", "job-b"], flags: { any: true, watch: true, json: true } }, deps: {
    resolveWorkspaceRoot: async () => process.cwd(),
    readJobRecord: async (_root, id) => ({ jobId: id, status: id === "job-a" && polls ? "completed" : "running" }),
    listJobRecords: async () => [],
    poll: async () => { polls++; }, stderrWrite: (text) => { output.push(text); },
  } });
  assert.equal(polls, 1); assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).jobs.map((item: any) => item.job.status), ["completed", "running"]);
  assert.equal(output.length, 2);
});

test("wait --timeout 0 probes once and leaves a running Job untouched", async () => {
  let polls = 0;
  const result = await runWait({ args: { positional: ["job-running"], flags: { timeout: "0" } }, deps: {
    resolveWorkspaceRoot: async () => process.cwd(), readJobRecord: async () => ({ jobId: "job-running", status: "running" }), poll: async () => { polls++; },
  } });
  assert.equal(result.exitCode, 4); assert.equal(polls, 0);
});

test("wait --active snapshots only the selected Host Session and does not add later Jobs", async () => {
  let listing = 0;
  const selected: string[] = [];
  const result = await runWait({ args: { positional: [], flags: { active: true, host: "pi", "host-session": "this-session", json: true } }, deps: {
    resolveWorkspaceRoot: async () => process.cwd(),
    listJobRecords: async () => {
      listing++;
      return [
        { jobId: "job-own", host: "pi", hostSessionId: "this-session", status: "running" },
        { jobId: "job-other", host: "pi", hostSessionId: "another-session", status: "running" },
        { jobId: "job-old", host: "pi", hostSessionId: "this-session", status: "completed" },
        ...(listing > 1 ? [{ jobId: "job-later", host: "pi", hostSessionId: "this-session", status: "running" }] : []),
      ];
    },
    readJobRecord: async (_root, id) => { selected.push(id); return { jobId: id, status: "completed" }; },
  } });
  assert.equal(result.exitCode, 0); assert.deepEqual(selected, ["job-own"]);
  assert.deepEqual(JSON.parse(result.stdout).jobs.map((item: any) => item.job.id), ["job-own"]);
});
