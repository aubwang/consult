import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import {
  MAX_REPORTS_PER_JOB,
  MAX_REPORT_MESSAGE_BYTES,
  REPORT_MESSAGE_TRUNCATED_MARKER,
} from "../job-reports.mts";
import { runLogs } from "./logs.mts";
import { runReport } from "./report.mts";

test("report appends one report line the log parser accepts", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-report", status: "running" });

  const result = await runReport({
    args: {
      positional: ["need", "the", "staging", "url"],
      flags: { type: "blocked", job: "job-report" },
    },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot, now: () => "2026-08-18T00:00:00.000Z" },
  });
  const logs = await runLogs({
    args: { positional: ["job-report"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "reported blocked for job-report\n");
  assert.deepEqual(JSON.parse(logs.stdout), [
    {
      method: "consult/report",
      params: {
        jobId: "job-report",
        at: "2026-08-18T00:00:00.000Z",
        type: "blocked",
        message: "need the staging url",
      },
    },
  ]);
});

test("report reads its Job and Workspace from the delegated environment", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-env", status: "running" });

  const result = await runReport({
    args: { positional: [], flags: { type: "progress", message: "half done" } },
    env: { CONSULT_PARENT_JOB: "job-env", CONSULT_WORKSPACE: workspaceRoot },
    deps: { now: () => "2026-08-18T00:00:01.000Z" },
  });

  assert.equal(result.exitCode, 0);
  const entries = await readLog(workspaceRoot, "job-env");
  assert.equal(entries.length, 1);
  assert.deepEqual((entries[0] as { params: unknown }).params, {
    jobId: "job-env",
    at: "2026-08-18T00:00:01.000Z",
    type: "progress",
    message: "half done",
  });
});

test("report prefers --job over the ambient parent Job", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-ambient", status: "running" });
  await writeJob(workspaceRoot, { jobId: "job-explicit", status: "running" });

  const result = await runReport({
    args: { positional: ["explicit"], flags: { type: "discovery", job: "job-explicit" } },
    env: { CONSULT_PARENT_JOB: "job-ambient", CONSULT_WORKSPACE: workspaceRoot },
    deps: {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal((await readLog(workspaceRoot, "job-ambient")).length, 0);
  assert.equal((await readLog(workspaceRoot, "job-explicit")).length, 1);
});

test("report carries a structured data payload alongside the message", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-data", status: "running" });

  const result = await runReport({
    args: {
      positional: ["found it"],
      flags: { type: "discovery", job: "job-data", data: '{"file":"src/queue.ts"}' },
    },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  const entries = await readLog(workspaceRoot, "job-data");
  assert.deepEqual((entries[0] as { params: { data: unknown } }).params.data, {
    file: "src/queue.ts",
  });
});

test("report exits 2 for an unknown Job and for a missing Job identity", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const unknown = await runReport({
    args: { positional: ["hello"], flags: { type: "progress", job: "missing" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const anonymous = await runReport({
    args: { positional: ["hello"], flags: { type: "progress" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.stderr, "job not found: missing\n");
  assert.equal(anonymous.exitCode, 2);
  assert.match(anonymous.stderr, /CONSULT_PARENT_JOB/u);
});

// The mirror of `result` before finalization: both are lifecycle-ordering
// violations, so both use exit code 5.
test("report exits 5 once the Job has finalized", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-final", status: "completed" });

  const result = await runReport({
    args: { positional: ["too late"], flags: { type: "progress", job: "job-final" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 5);
  assert.equal(result.stderr, "job already finalized; cannot report (status=completed)\n");
  assert.equal((await readLog(workspaceRoot, "job-final")).length, 0);
});

// A report written before the Profile turn starts would render after the
// running transition it actually preceded, so the running window is closed at
// both ends.
test("report exits 5 before the Job starts running", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-queued", status: "queued" });

  const result = await runReport({
    args: { positional: ["too early"], flags: { type: "progress", job: "job-queued" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 5);
  assert.equal(result.stderr, "job not running yet; cannot report (status=queued)\n");
  assert.equal((await readLog(workspaceRoot, "job-queued")).length, 0);
});

// The Broker can finalize between the pre-check and the append. Readers void
// the line either way; the re-read is what stops the caller believing the
// report landed.
test("report exits 5 when the Job finalizes during the append", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-race", status: "running" });
  let reads = 0;

  const result = await runReport({
    args: { positional: ["racing"], flags: { type: "progress", job: "job-race" } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      readJobRecord: async (_workspaceRoot, jobId) => {
        reads += 1;
        return { jobId, status: reads === 1 ? "running" : "completed" };
      },
    },
  });

  assert.equal(reads, 2);
  assert.equal(result.exitCode, 5);
  assert.equal(
    result.stderr,
    "job finalized during report; report discarded (status=completed)\n",
  );
});

test("report validates the type, the message, and unknown flags", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-validate", status: "running" });
  const deps = { resolveWorkspaceRoot: async () => workspaceRoot };

  const unknownType = await runReport({
    args: { positional: ["hi"], flags: { type: "BLOCKED", job: "job-validate" } },
    env: {},
    deps,
  });
  const missingType = await runReport({
    args: { positional: ["hi"], flags: { job: "job-validate" } },
    env: {},
    deps,
  });
  const missingMessage = await runReport({
    args: { positional: [], flags: { type: "progress", job: "job-validate" } },
    env: {},
    deps,
  });
  const unknownFlag = await runReport({
    args: { positional: ["hi"], flags: { typ: "progress" } },
    env: {},
    deps,
  });

  assert.equal(unknownType.exitCode, 2);
  assert.match(unknownType.stderr, /unknown report type: BLOCKED/u);
  assert.equal(missingType.exitCode, 2);
  assert.equal(missingType.stderr, "--type is required\n");
  assert.equal(missingMessage.exitCode, 2);
  assert.equal(missingMessage.stderr, "report message is required\n");
  assert.equal(unknownFlag.exitCode, 2);
  assert.match(unknownFlag.stderr, /--typ is not supported/u);
  assert.equal((await readLog(workspaceRoot, "job-validate")).length, 0);
});

test("report truncates an overlong message inside the byte bound", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-long", status: "running" });

  const result = await runReport({
    args: {
      positional: [],
      flags: { type: "progress", job: "job-long", message: "é".repeat(4000) },
    },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  const entries = await readLog(workspaceRoot, "job-long");
  const message = (entries[0] as { params: { message: string } }).params.message;
  assert.ok(message.endsWith(REPORT_MESSAGE_TRUNCATED_MARKER));
  assert.equal(Buffer.byteLength(message), MAX_REPORT_MESSAGE_BYTES);
});

test("report rejects malformed and oversized --data without writing", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-payload", status: "running" });
  const deps = { resolveWorkspaceRoot: async () => workspaceRoot };

  const malformed = await runReport({
    args: { positional: ["hi"], flags: { type: "progress", job: "job-payload", data: "{oops" } },
    env: {},
    deps,
  });
  const oversized = await runReport({
    args: {
      positional: ["hi"],
      flags: {
        type: "progress",
        job: "job-payload",
        data: JSON.stringify({ blob: "x".repeat(17 * 1024) }),
      },
    },
    env: {},
    deps,
  });

  assert.equal(malformed.exitCode, 2);
  assert.equal(malformed.stderr, "--data must be valid JSON\n");
  assert.equal(oversized.exitCode, 2);
  assert.match(oversized.stderr, /the limit is 16384\n$/u);
  assert.equal((await readLog(workspaceRoot, "job-payload")).length, 0);
});

// A voided line is in the file but not in the stream, so it must not consume
// the Job's report budget either.
test("report does not count report lines voided by finalization", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-void", status: "running" });
  await writeLog(workspaceRoot, "job-void", [
    reportLine("job-void", "progress", "counted"),
    { method: "consult/finalized", params: { jobId: "job-void", stopReason: "end_turn" } },
    reportLine("job-void", "progress", "voided"),
  ]);
  let counted = 0;

  const result = await runReport({
    args: { positional: ["another"], flags: { type: "progress", job: "job-void" } },
    env: {},
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      readJobRecord: async (_workspaceRoot, jobId) => ({ jobId, status: "running" }),
      readLogFile: async (path) => {
        counted += 1;
        return await fs.readFile(path, "utf8");
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(counted, 1);
  assert.equal((await readLog(workspaceRoot, "job-void")).length, 4);
});

test("report refuses to grow a Job's log past the report cap", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-cap", status: "running" });
  await writeLog(
    workspaceRoot,
    "job-cap",
    Array.from({ length: MAX_REPORTS_PER_JOB }, (_, index) => ({
      method: "consult/report",
      params: {
        jobId: "job-cap",
        at: "2026-08-18T00:00:00.000Z",
        type: "progress",
        message: `step ${index}`,
      },
    })),
  );

  const result = await runReport({
    args: { positional: ["one more"], flags: { type: "progress", job: "job-cap" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /already holds 256 reports \(limit 256\)/u);
  assert.equal((await readLog(workspaceRoot, "job-cap")).length, MAX_REPORTS_PER_JOB);
});

test("a report line leaves consult logs and later finalization intact", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, { jobId: "job-mixed", status: "running" });
  await writeLog(workspaceRoot, "job-mixed", [agentText("job-mixed", "working\n")]);

  await runReport({
    args: { positional: ["need", "a", "token"], flags: { type: "blocked", job: "job-mixed" } },
    env: {},
    deps: { resolveWorkspaceRoot: async () => workspaceRoot, now: () => "2026-08-18T00:00:02.000Z" },
  });
  await appendLog(workspaceRoot, "job-mixed", [
    { method: "consult/finalized", params: { jobId: "job-mixed", stopReason: "end_turn" } },
  ]);
  await writeJob(workspaceRoot, {
    jobId: "job-mixed",
    status: "completed",
    finalText: "working\n",
  });

  const rendered = await runLogs({
    args: { positional: ["job-mixed"], flags: {} },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });
  const json = await runLogs({
    args: { positional: ["job-mixed"], flags: { json: true } },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(rendered.exitCode, 0);
  assert.equal(rendered.stdout, "working\n[report blocked: need a token]\n");
  assert.equal(json.exitCode, 0);
  assert.equal(JSON.parse(json.stdout).length, 3);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "consult-report-")));
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
): Promise<void> {
  const dir = logsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${jobId}.log`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function appendLog(
  workspaceRoot: string,
  jobId: string,
  entries: unknown[],
): Promise<void> {
  await fs.appendFile(
    path.join(logsDir(workspaceRoot), `${jobId}.log`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

async function readLog(workspaceRoot: string, jobId: string): Promise<unknown[]> {
  let contents: string;
  try {
    contents = await fs.readFile(path.join(logsDir(workspaceRoot), `${jobId}.log`), "utf8");
  } catch {
    return [];
  }
  return contents
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function reportLine(jobId: string, type: string, message: string): Record<string, unknown> {
  return {
    method: "consult/report",
    params: { jobId, at: "2026-08-18T00:00:00.000Z", type, message },
  };
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
