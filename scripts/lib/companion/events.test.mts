import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import { runEvents } from "./events.mts";
import { runLogs } from "./logs.mts";
import { runReport } from "./report.mts";

test("events orders lifecycle transitions around the derived report sequence", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-order",
    status: "completed",
    submittedAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-order", [
    report("job-order", "progress", "reading", "2026-08-18T00:00:02.000Z"),
    agentText("job-order", "thinking"),
    report("job-order", "blocked", "need a token", "2026-08-18T00:00:03.000Z"),
  ]);

  const result = await runEvents({
    args: { positional: ["job-order"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    jobId: "job-order",
    events: [
      { kind: "lifecycle", type: "queued", at: "2026-08-18T00:00:00.000Z" },
      { kind: "lifecycle", type: "running", at: "2026-08-18T00:00:01.000Z" },
      {
        kind: "report",
        type: "progress",
        at: "2026-08-18T00:00:02.000Z",
        seq: 1,
        message: "reading",
      },
      {
        kind: "report",
        type: "blocked",
        at: "2026-08-18T00:00:03.000Z",
        seq: 2,
        message: "need a token",
      },
      {
        kind: "lifecycle",
        type: "terminal",
        at: "2026-08-18T00:00:09.000Z",
        status: "completed",
      },
    ],
  });
});

test("events synthesizes only the transitions a Job record has reached", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-queued",
    status: "queued",
    submittedAt: "2026-08-18T00:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-failed",
    status: "failed",
    submittedAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
    completedAt: "2026-08-18T00:00:02.000Z",
    errorMessage: "profile launch failed",
  });
  const deps = { resolveWorkspaceRoot: async () => workspaceRoot };

  const queued = await runEvents({
    args: { positional: ["job-queued"], flags: { json: true } },
    env: {},
    deps,
  });
  const failed = await runEvents({
    args: { positional: ["job-failed"], flags: {} },
    env: {},
    deps,
  });

  assert.deepEqual(JSON.parse(queued.stdout).events, [
    { kind: "lifecycle", type: "queued", at: "2026-08-18T00:00:00.000Z" },
  ]);
  assert.equal(
    failed.stdout,
    "[2026-08-18T00:00:00.000Z] queued\n" +
      "[2026-08-18T00:00:01.000Z] running\n" +
      "[2026-08-18T00:00:02.000Z] terminal: failed - profile launch failed\n",
  );
});

test("events renders reports with their sequence, message, and data", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-render", status: "running" });
  await writeLog(workspaceRoot, "job-render", [
    {
      method: "consult/report",
      params: {
        jobId: "job-render",
        at: "2026-08-18T00:00:04.000Z",
        type: "discovery",
        message: "two\nlines",
        data: { file: "src/queue.ts" },
      },
    },
  ]);

  const result = await runEvents({
    args: { positional: ["job-render"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(
    result.stdout,
    '[2026-08-18T00:00:04.000Z] #1 discovery: two lines\n    data: {"file":"src/queue.ts"}\n',
  );
});

// The log is multi-writer, so a reporter can lose the race with finalization.
// The reader is what makes the resulting stream deterministic.
test("events voids report lines that landed after finalization", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-void",
    status: "completed",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-void", [
    report("job-void", "progress", "admitted", "2026-08-18T00:00:01.000Z"),
    { method: "consult/finalized", params: { jobId: "job-void", stopReason: "end_turn" } },
    report("job-void", "blocked", "raced", "2026-08-18T00:00:10.000Z"),
  ]);

  const events = await runEvents({
    args: { positional: ["job-void"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const logs = await runLogs({
    args: { positional: ["job-void"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.deepEqual(
    JSON.parse(events.stdout).events.map((event: { type: string; seq?: number }) => [
      event.type,
      event.seq,
    ]),
    [
      ["progress", 1],
      ["terminal", undefined],
    ],
  );
  // logs stays the raw transcript: it still shows the line events voided.
  assert.equal(
    logs.stdout,
    "[report progress: admitted]\n[report blocked: raced]\n",
  );
});

// Reports and steers are one ordered stream of interim events, so they share a
// sequence space: --since after a report must not skip a steer behind it.
test("events interleaves steer events with reports in one sequence space", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-steer",
    status: "completed",
    submittedAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-steer", [
    report("job-steer", "decision_needed", "which schema?", "2026-08-18T00:00:02.000Z"),
    agentText("job-steer", "waiting"),
    steer("job-steer", "the schema is frozen;\nskip the migration", "2026-08-18T00:00:03.000Z"),
  ]);

  const result = await runEvents({
    args: { positional: ["job-steer"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const filtered = await runEvents({
    args: { positional: ["job-steer"], flags: { type: "steer" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).events, [
    { kind: "lifecycle", type: "queued", at: "2026-08-18T00:00:00.000Z" },
    { kind: "lifecycle", type: "running", at: "2026-08-18T00:00:01.000Z" },
    {
      kind: "report",
      type: "decision_needed",
      at: "2026-08-18T00:00:02.000Z",
      seq: 1,
      message: "which schema?",
    },
    {
      kind: "steer",
      type: "steer",
      at: "2026-08-18T00:00:03.000Z",
      seq: 2,
      message: "the schema is frozen; skip the migration",
    },
    {
      kind: "lifecycle",
      type: "terminal",
      at: "2026-08-18T00:00:09.000Z",
      status: "completed",
    },
  ]);
  assert.equal(filtered.exitCode, 0);
  assert.equal(
    filtered.stdout,
    "[2026-08-18T00:00:03.000Z] #2 steer: the schema is frozen; skip the migration\n",
  );
});

test("events previews long guidance while logs keeps the raw transcript line", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-preview", status: "running" });
  const guidance = "g".repeat(500);
  await writeLog(workspaceRoot, "job-preview", [
    steer("job-preview", guidance, "2026-08-18T00:00:03.000Z"),
  ]);

  const events = await runEvents({
    args: { positional: ["job-preview"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const logs = await runLogs({
    args: { positional: ["job-preview"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  const message = JSON.parse(events.stdout).events[0].message;
  assert.equal(message.length, 200);
  assert.equal(message, `${"g".repeat(197)}...`);
  // The full guidance is still one line up, in the raw log.
  assert.equal(JSON.parse(logs.stdout)[0].params.guidance, guidance);
});

// Steer lines obey the same read-time void rule as reports: `logs` is the raw
// transcript, `events` is the contract and stops at finalization.
test("events voids steer lines that landed after finalization", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-steer-void",
    status: "completed",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-steer-void", [
    steer("job-steer-void", "admitted", "2026-08-18T00:00:01.000Z"),
    { method: "consult/finalized", params: { jobId: "job-steer-void", stopReason: "end_turn" } },
    steer("job-steer-void", "raced", "2026-08-18T00:00:10.000Z"),
  ]);

  const events = await runEvents({
    args: { positional: ["job-steer-void"], flags: { json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const logs = await runLogs({
    args: { positional: ["job-steer-void"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.deepEqual(
    JSON.parse(events.stdout).events.map((event: { type: string; seq?: number }) => [
      event.type,
      event.seq,
    ]),
    [
      ["steer", 1],
      ["terminal", undefined],
    ],
  );
  assert.equal(logs.stdout, "[steer: admitted]\n[steer: raced]\n");
});

test("events --since skips read reports while keeping lifecycle transitions", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-since",
    status: "completed",
    submittedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-since", [
    report("job-since", "progress", "one", "2026-08-18T00:00:01.000Z"),
    report("job-since", "progress", "two", "2026-08-18T00:00:02.000Z"),
    report("job-since", "progress", "three", "2026-08-18T00:00:03.000Z"),
  ]);

  const result = await runEvents({
    args: { positional: ["job-since"], flags: { since: "2", json: true } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const invalid = await runEvents({
    args: { positional: ["job-since"], flags: { since: "-1" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.deepEqual(
    JSON.parse(result.stdout).events.map((event: { type: string; seq?: number }) => [
      event.type,
      event.seq,
    ]),
    [
      ["queued", undefined],
      ["progress", 3],
      ["terminal", undefined],
    ],
  );
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.stderr, "--since must be a non-negative integer\n");
});

test("events --type selects one event type and rejects an unknown one", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-type",
    status: "completed",
    submittedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:00:09.000Z",
  });
  await writeLog(workspaceRoot, "job-type", [
    report("job-type", "progress", "one", "2026-08-18T00:00:01.000Z"),
    report("job-type", "blocked", "stuck", "2026-08-18T00:00:02.000Z"),
  ]);
  const deps = { resolveWorkspaceRoot: async () => workspaceRoot };

  const blocked = await runEvents({
    args: { positional: ["job-type"], flags: { type: "blocked", json: true } },
    env: {},
    deps,
  });
  const terminal = await runEvents({
    args: { positional: ["job-type"], flags: { type: "terminal", json: true } },
    env: {},
    deps,
  });
  const unknown = await runEvents({
    args: { positional: ["job-type"], flags: { type: "lifecycle" } },
    env: {},
    deps,
  });

  assert.deepEqual(JSON.parse(blocked.stdout).events, [
    {
      kind: "report",
      type: "blocked",
      at: "2026-08-18T00:00:02.000Z",
      seq: 2,
      message: "stuck",
    },
  ]);
  assert.equal(JSON.parse(terminal.stdout).events.length, 1);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /unknown event type: lifecycle/u);
});

test("events follow streams new events and stops at the terminal transition", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-follow",
    status: "running",
    submittedAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
  });
  await writeLog(workspaceRoot, "job-follow", [
    report("job-follow", "progress", "one", "2026-08-18T00:00:02.000Z"),
  ]);
  const streamed: string[] = [];

  const result = await runEvents({
    args: { positional: ["job-follow"], flags: { follow: true } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text) => streamed.push(text),
      poll: async () => {
        await appendLog(workspaceRoot, "job-follow", [
          report("job-follow", "blocked", "stuck", "2026-08-18T00:00:03.000Z"),
        ]);
        await writeJob(workspaceRoot, {
          jobId: "job-follow",
          status: "completed",
          submittedAt: "2026-08-18T00:00:00.000Z",
          startedAt: "2026-08-18T00:00:01.000Z",
          completedAt: "2026-08-18T00:00:04.000Z",
        });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(streamed, [
    "[2026-08-18T00:00:00.000Z] queued\n",
    "[2026-08-18T00:00:01.000Z] running\n",
    "[2026-08-18T00:00:02.000Z] #1 progress: one\n",
    "[2026-08-18T00:00:03.000Z] #2 blocked: stuck\n",
    "[2026-08-18T00:00:04.000Z] terminal: completed\n",
  ]);
});

test("events follow with --json streams one framed event per line", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-ndjson",
    status: "running",
    submittedAt: "2026-08-18T00:00:00.000Z",
  });
  const streamed: string[] = [];

  await runEvents({
    args: { positional: ["job-ndjson"], flags: { follow: true, json: true } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text) => streamed.push(text),
      poll: async () => {
        await writeJob(workspaceRoot, {
          jobId: "job-ndjson",
          status: "cancelled",
          submittedAt: "2026-08-18T00:00:00.000Z",
          completedAt: "2026-08-18T00:00:05.000Z",
        });
      },
    },
  });

  const lines = streamed.join("").split("\n").filter((line) => line !== "");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        schemaVersion: 1,
        jobId: "job-ndjson",
        event: { kind: "lifecycle", type: "queued", at: "2026-08-18T00:00:00.000Z" },
      },
      {
        schemaVersion: 1,
        jobId: "job-ndjson",
        event: {
          kind: "lifecycle",
          type: "terminal",
          at: "2026-08-18T00:00:05.000Z",
          status: "cancelled",
        },
      },
    ],
  );
});

test("events follow skips a partially flushed report line and picks it up later", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-partial", status: "running" });
  const line = JSON.stringify(report("job-partial", "progress", "one", "2026-08-18T00:00:01.000Z"));
  await writeRawLog(workspaceRoot, "job-partial", line.slice(0, 12));
  const streamed: string[] = [];

  const result = await runEvents({
    args: { positional: ["job-partial"], flags: { follow: true } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      stdoutWrite: (text) => streamed.push(text),
      poll: async () => {
        await writeRawLog(workspaceRoot, "job-partial", `${line}\n`);
        await writeJob(workspaceRoot, { jobId: "job-partial", status: "completed" });
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(streamed, [
    "[2026-08-18T00:00:01.000Z] #1 progress: one\n",
    "[-] terminal: completed\n",
  ]);
});

test("events follow exits 4 when the Job never finalizes", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-timeout", status: "running" });
  const streamedErrors: string[] = [];
  let now = 0;

  const result = await runEvents({
    args: { positional: ["job-timeout"], flags: { follow: true } },
    env: {},
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
  assert.match(streamedErrors.join(""), /timed out following job job-timeout/u);
});

test("events exits 2 for an unknown Job, a missing id, and an unknown flag", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const deps = { resolveWorkspaceRoot: async () => workspaceRoot };

  const unknown = await runEvents({ args: { positional: ["missing"], flags: {} }, env: {}, deps });
  const missingId = await runEvents({ args: { positional: [], flags: {} }, env: {}, deps });
  const unknownFlag = await runEvents({
    args: { positional: ["job-x"], flags: { tail: "2" } },
    env: {},
    deps,
  });

  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.stderr, "job not found: missing\n");
  assert.equal(missingId.exitCode, 2);
  assert.equal(missingId.stderr, "job id is required\n");
  assert.equal(unknownFlag.exitCode, 2);
  assert.match(unknownFlag.stderr, /--tail is not supported/u);
});

// The two commands read the same file: reports must survive interleaving with
// ordinary session updates in both views.
test("interleaved reports and updates satisfy both events and logs", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-mix",
    status: "running",
    submittedAt: "2026-08-18T00:00:00.000Z",
    startedAt: "2026-08-18T00:00:01.000Z",
  });
  await writeLog(workspaceRoot, "job-mix", [agentText("job-mix", "starting\n")]);
  const reportDeps = {
    resolveWorkspaceRoot: async () => workspaceRoot,
    now: () => "2026-08-18T00:00:02.000Z",
  };

  await runReport({
    args: { positional: ["found the race"], flags: { type: "discovery", job: "job-mix" } },
    env: {},
    deps: reportDeps,
  });
  await appendLog(workspaceRoot, "job-mix", [agentText("job-mix", "still going\n")]);
  await runReport({
    args: { positional: ["need a token"], flags: { type: "blocked", job: "job-mix" } },
    env: {},
    deps: { ...reportDeps, now: () => "2026-08-18T00:00:03.000Z" },
  });
  await appendLog(workspaceRoot, "job-mix", [agentText("job-mix", "done\n")]);

  const events = await runEvents({
    args: { positional: ["job-mix"], flags: {} },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const logs = await runLogs({
    args: { positional: ["job-mix"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const logsJson = await runLogs({
    args: { positional: ["job-mix"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(
    events.stdout,
    "[2026-08-18T00:00:00.000Z] queued\n" +
      "[2026-08-18T00:00:01.000Z] running\n" +
      "[2026-08-18T00:00:02.000Z] #1 discovery: found the race\n" +
      "[2026-08-18T00:00:03.000Z] #2 blocked: need a token\n",
  );
  assert.equal(
    logs.stdout,
    "starting\n[report discovery: found the race]\nstill going\n[report blocked: need a token]\ndone\n",
  );
  assert.equal(JSON.parse(logsJson.stdout).length, 5);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-events-"));
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

async function writeLog(workspaceRoot: string, jobId: string, entries: unknown[]): Promise<void> {
  await writeRawLog(
    workspaceRoot,
    jobId,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function appendLog(workspaceRoot: string, jobId: string, entries: unknown[]): Promise<void> {
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
): Promise<void> {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${jobId}.log`), content, "utf8");
}

function report(
  jobId: string,
  type: string,
  message: string,
  at: string,
): Record<string, unknown> {
  return { method: "consult/report", params: { jobId, at, type, message } };
}

function steer(jobId: string, guidance: string, at: string): Record<string, unknown> {
  return { method: "consult/steer", params: { jobId, at, guidance } };
}

function agentText(jobId: string, text: string): Record<string, unknown> {
  return {
    method: "consult/update",
    params: {
      jobId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  };
}
