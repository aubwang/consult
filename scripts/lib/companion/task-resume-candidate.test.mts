import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { jobsDir } from "../broker-endpoint.mts";
import { runTaskResumeCandidate } from "./task-resume-candidate.mts";

test("task-resume-candidate returns the latest resumable job for a profile", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeJob(workspaceRoot, {
    jobId: "job-old",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "codex",
    status: "completed",
    sessionId: "session-old",
    completedAt: "2026-05-14T09:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-new",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "codex",
    status: "failed",
    sessionId: "session-new",
    completedAt: "2026-05-14T10:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-other-profile",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "claude",
    status: "completed",
    sessionId: "session-other",
    completedAt: "2026-05-14T11:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-running",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "codex",
    status: "running",
    sessionId: "session-running",
    completedAt: "2026-05-14T12:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "job-cancelled",
    host: "claude-code",
    hostSessionId: "claude-1",
    profile: "codex",
    status: "cancelled",
    sessionId: "session-cancelled",
    completedAt: "2026-05-14T13:00:00.000Z",
  });

  const result = await runTaskResumeCandidate({
    args: { positional: [], flags: { profile: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    found: true,
    profile: "codex",
    jobId: "job-new",
    status: "failed",
    sessionId: "session-new",
    completedAt: "2026-05-14T10:00:00.000Z",
  });
});

test("task-resume-candidate returns found false when no candidate exists", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runTaskResumeCandidate({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { found: false, profile: "codex" });
});

test("task-resume-candidate requires a profile", async () => {
  const result = await runTaskResumeCandidate({
    args: { positional: [], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "profile is required\n");
});

test("task-resume-candidate exits 2 for a malformed job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = path.join(jobsDir(workspaceRoot), "job-bad.json");
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");

  const result = await runTaskResumeCandidate({
    args: { positional: [], flags: { profile: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: { resolveWorkspaceRoot: async () => workspaceRoot },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-task-resume-"));
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
