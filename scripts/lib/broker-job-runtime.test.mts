import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { createBrokerJobRuntime } from "./broker-job-runtime.mts";
import type { BrokerAgentHandle, BrokerJobSocketLike } from "./broker-job-runtime.mts";
import { TEXT_TRUNCATED_MARKER } from "./bounded-text.mts";
import { readWorkspaceJobRecord } from "./job-records.mts";
import {
  JOB_LOG_LIMIT_EXCEEDED,
  JOB_WALL_CLOCK_LIMIT_EXCEEDED,
  jobLogLineBytes,
} from "./job-reliability.mts";

test("broker job runtime buffers updates and notifies subscribers on finalize", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: Array<{ socket: string; method: string; params: any }> = [];
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => {
      throw new Error("agent should not be needed");
    },
    hashRunPayload: () => "payload-hash",
    writeNotification(socket: BrokerJobSocketLike, method: string, params: unknown) {
      notifications.push({ socket: (socket as FakeSocket).name, method, params });
    },
  });

  const subscriber = fakeSocket("subscriber");
  const job = runtime.createJob(
    {
      jobId: "job-runtime",
      kind: "delegate",
      profile: "codex",
      mode: "write",
      prompt: "fix",
      submittedAt: "2026-05-21T10:00:00.000Z",
    },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, subscriber);
  runtime.trackSession("session-1", job);

  await runtime.handleSessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
  });
  await runtime.finalizeJob(job, { stopReason: "end_turn", sessionId: "session-1" });

  assert.equal(runtime.getJob("job-runtime"), job);
  assert.equal(runtime.hasRunningJob(), false);
  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ["consult/update", "consult/finalized"],
  );
  assert.equal(notifications.at(0)!.params.update.content.text, "hello");
  assert.equal(notifications.at(1)!.params.stopReason, "end_turn");
  assert.equal(job.finalText, "hello");
});

test("broker job runtime reports unconfirmed cleanup as a failed terminal outcome", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: Array<{ method: string; params: any }> = [];
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => {
      throw new Error("agent should not be needed");
    },
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, method, params) {
      notifications.push({ method, params });
    },
    beforeTerminal: async () => {
      throw new Error("process target remained alive after SIGKILL");
    },
  });
  const job = runtime.createJob(
    {
      jobId: "job-cleanup-unconfirmed",
      profile: "codex",
      mode: "read-only",
      prompt: "inspect",
    },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));
  runtime.trackSession("session-cleanup", job);

  await runtime.finalizeJob(job, {
    stopReason: "end_turn",
    sessionId: "session-cleanup",
  });

  assert.equal(job.finalized?.stopReason, "failed");
  assert.match(
    job.finalized?.errorMessage ?? "",
    /PROFILE_CLEANUP_UNCONFIRMED: process target remained alive after SIGKILL/u,
  );
  assert.equal(notifications.at(-1)?.method, "consult/finalized");
  assert.equal(notifications.at(-1)?.params.stopReason, "failed");
  const record = await readWorkspaceJobRecord(workspaceRoot, job.jobId);
  assert.equal(record.status, "failed");
  assert.match(record.errorMessage ?? "", /PROFILE_CLEANUP_UNCONFIRMED/u);
});

test("broker job runtime caps accumulated final text", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => {
      throw new Error("agent should not be needed");
    },
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
    maxFinalTextChars: 40,
  });
  const job = runtime.createJob(
    {
      jobId: "job-runtime-long",
      kind: "delegate",
      profile: "codex",
      mode: "write",
      prompt: "fix",
    },
    fakeSocket("originator"),
  );
  runtime.trackSession("session-1", job);

  await runtime.handleSessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    },
  });

  assert.equal(job.finalText.length, 40);
  assert.equal(job.finalText, `abcdefg${TEXT_TRUNCATED_MARKER}`);
});

test("broker job runtime keeps tool progress out of accumulated final text", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: unknown[] = [];
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => {
      throw new Error("agent should not be needed");
    },
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, _method, params) {
      notifications.push(params);
    },
  });
  const job = runtime.createJob(
    {
      jobId: "job-progress",
      kind: "delegate",
      profile: "codex",
      mode: "write",
      prompt: "fix",
    },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));
  runtime.trackSession("session-progress", job);

  await runtime.handleSessionUpdate({
    sessionId: "session-progress",
    update: { sessionUpdate: "tool_call", kind: "shell", title: "run tests" },
  });
  await runtime.handleSessionUpdate({
    sessionId: "session-progress",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    },
  });

  assert.equal(job.finalText, "done");
  assert.equal(notifications.length, 2);
});

test("broker job runtime carries canonical authority to the tracked session", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => {
      throw new Error("agent should not be needed");
    },
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
  });
  const enabledJob = runtime.createJob(
    {
      jobId: "job-execute-enabled",
      profile: "codex",
      mode: "write",
      authority: authority({ mode: "write", allowExecute: true }),
      prompt: "run tests",
      allowExecute: true,
    },
    fakeSocket("enabled-originator"),
  );
  const defaultJob = runtime.createJob(
    {
      jobId: "job-execute-default",
      profile: "codex",
      mode: "write",
      authority: authority({ mode: "write" }),
      prompt: "run tests",
    },
    fakeSocket("default-originator"),
  );
  const fetchJob = runtime.createJob(
    {
      jobId: "job-fetch-enabled",
      profile: "codex",
      authority: authority({ allowFetch: true }),
      prompt: "research",
    },
    fakeSocket("fetch-originator"),
  );

  runtime.trackSession("session-enabled", enabledJob);
  runtime.trackSession("session-default", defaultJob);
  runtime.trackSession("session-fetch", fetchJob);

  assert.equal(enabledJob.allowExecute, true);
  assert.equal(defaultJob.allowExecute, false);
  assert.deepEqual(runtime.getSessionAuthority("session-enabled"), enabledJob.authority);
  assert.deepEqual(runtime.getSessionAuthority("session-default"), defaultJob.authority);
  assert.equal(runtime.getSessionAuthority("session-fetch")?.allowFetch, true);
  assert.equal(runtime.getSessionAuthority("session-unknown"), undefined);
});

test("cancelJob ensures the agent with the running job's own mode", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const modes: Array<string | undefined> = [];
  const cancelledSessions: string[] = [];
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async (authority) => {
      modes.push(authority.mode);
      return {
        connection: {
          cancel: async ({ sessionId }: { sessionId: string }) => {
            cancelledSessions.push(sessionId);
          },
        },
      } as unknown as BrokerAgentHandle;
    },
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
  });
  const job = runtime.createJob(
    {
      jobId: "job-cancel-mode",
      kind: "delegate",
      profile: "codex",
      mode: "write",
      prompt: "fix",
    },
    fakeSocket("originator"),
  );
  runtime.trackSession("session-1", job);

  await runtime.cancelJob(job);

  // A bare ensureAgent() would default to read-only and restart a sandboxed
  // write-mode agent mid-turn instead of cancelling on the live one.
  assert.deepEqual(modes, ["write"]);
  assert.deepEqual(cancelledSessions, ["session-1"]);
  await runtime.finalizeJob(job, { stopReason: "cancelled", sessionId: "session-1" });
});

test("cancelJob finalizes a Job cancelled before a session exists", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: Array<{ method: string; params: any }> = [];
  const runtime = createBrokerJobRuntime({
    config: { cwd: workspaceRoot, host: "terminal", hostSessionId: "default", cancelAckTimeoutMs: 25 },
    ensureAgent: async () => { throw new Error("agent must not be needed"); },
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, method, params) { notifications.push({ method, params }); },
  });
  const job = runtime.createJob(
    { jobId: "job-cancel-before-session", profile: "codex", mode: "write", prompt: "fix" },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));

  await runtime.cancelJob(job);

  assert.equal(job.status, "finalized");
  assert.equal(job.finalized?.stopReason, "cancelled");
  assert.equal(runtime.isTainted(), false);
  assert.equal(notifications.at(-1)?.method, "consult/finalized");
  assert.equal((await readWorkspaceJobRecord(workspaceRoot, job.jobId)).status, "cancelled");
});

test("attach during terminal preparation waits for the complete finalized outcome", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => { release = resolve; });
  const notifications: Array<{ socket: string; method: string; params: any }> = [];
  const runtime = createBrokerJobRuntime({
    config: { cwd: workspaceRoot, host: "terminal", hostSessionId: "default", cancelAckTimeoutMs: 2000 },
    ensureAgent: async () => { throw new Error("agent must not be needed"); },
    hashRunPayload: () => "payload-hash",
    writeNotification(socket, method, params) {
      notifications.push({ socket: (socket as FakeSocket).name, method, params });
    },
    beforeTerminal: async () => await terminalGate,
  });
  const job = runtime.createJob(
    { jobId: "job-attach-terminal", profile: "codex", mode: "read-only", prompt: "inspect" },
    fakeSocket("originator"),
  );
  const finalizing = runtime.failJob(job, "original failure");
  await waitFor(() => job.status === "finalized");
  runtime.attachJob(job, fakeSocket("late-subscriber"));

  assert.equal(notifications.length, 0);
  release();
  await finalizing;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.stopReason, "failed");
  assert.equal(notifications[0].params.errorMessage, "original failure");
});

test("terminal record write failure still notifies subscribers and runs terminal cleanup", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: Array<{ method: string; params: any }> = [];
  const terminalJobs: string[] = [];
  const runtime = createBrokerJobRuntime({
    config: { cwd: workspaceRoot, host: "terminal", hostSessionId: "default", cancelAckTimeoutMs: 2000 },
    ensureAgent: async () => { throw new Error("agent must not be needed"); },
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, method, params) { notifications.push({ method, params }); },
    persistJobRecord: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    onTerminal(job) { terminalJobs.push(job.jobId); },
  });
  const job = runtime.createJob(
    { jobId: "job-terminal-write-failure", profile: "codex", mode: "read-only", prompt: "inspect" },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));

  await runtime.finalizeJob(job, { stopReason: "end_turn", sessionId: "session-1" });

  assert.equal(notifications.at(-1)?.method, "consult/finalized");
  assert.equal(notifications.at(-1)?.params.stopReason, "failed");
  assert.match(notifications.at(-1)?.params.errorMessage, /job record write failed: disk full/u);
  assert.deepEqual(terminalJobs, [job.jobId]);
});

test("cancel acknowledgement timeout does not taint while terminal preparation is in progress", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createBrokerJobRuntime({
    config: { cwd: workspaceRoot, host: "terminal", hostSessionId: "default", cancelAckTimeoutMs: 20 },
    ensureAgent: async () => ({ connection: { cancel: async () => {} } } as unknown as BrokerAgentHandle),
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
    beforeTerminal: async () => await terminalGate,
  });
  const job = runtime.createJob(
    { jobId: "job-cancel-dispose", profile: "codex", mode: "read-only", prompt: "inspect" },
    fakeSocket("originator"),
  );
  runtime.trackSession("session-1", job);
  await runtime.cancelJob(job);
  const finalizing = runtime.finalizeJob(job, { stopReason: "cancelled", sessionId: "session-1" });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(runtime.isTainted(), false);
  release();
  await finalizing;
});

test("persisted log limit drops the overflowing update, preserves partial output, and cancels", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications: Array<{ method: string; params: any }> = [];
  const cancelledSessions: string[] = [];
  const terminalJobs: string[] = [];
  const jobId = "job-log-limit";
  const keptUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "kept partial" },
  };
  const maxPersistedLogBytes = 1024;
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => ({
      connection: {
        cancel: async ({ sessionId }: { sessionId: string }) => {
          cancelledSessions.push(sessionId);
        },
      },
    } as unknown as BrokerAgentHandle),
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, method, params) {
      notifications.push({ method, params });
    },
    onTerminal(job) {
      terminalJobs.push(job.jobId);
    },
    maxPersistedLogBytes,
  });
  const job = runtime.createJob(
    { jobId, profile: "codex", mode: "read-only", prompt: "inspect" },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));
  runtime.trackSession("session-log-limit", job);

  await runtime.handleSessionUpdate({ sessionId: "session-log-limit", update: keptUpdate });
  await runtime.handleSessionUpdate({
    sessionId: "session-log-limit",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x".repeat(2000) },
    },
  });
  await waitFor(() => cancelledSessions.length === 1);

  assert.equal(job.status, "finalized");
  assert.equal(job.finalized?.stopReason, "failed");
  assert.match(job.finalized?.errorMessage ?? "", new RegExp(`^${JOB_LOG_LIMIT_EXCEEDED}:`));
  assert.equal(job.finalText, "kept partial");
  assert.deepEqual(cancelledSessions, ["session-log-limit"]);
  assert.deepEqual(terminalJobs, [jobId]);
  assert.deepEqual(notifications.map((entry) => entry.method), ["consult/update", "consult/finalized"]);
  assert.ok(
    notifications.reduce(
      (total, entry) => total + jobLogLineBytes(entry.method, entry.params),
      0,
    ) <= maxPersistedLogBytes,
  );
  const record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  assert.equal(record.status, "failed");
  assert.equal(record.finalText, "kept partial");
  assert.match(record.errorMessage ?? "", new RegExp(`^${JOB_LOG_LIMIT_EXCEEDED}:`));
  runtime.noteTurnSettled(job);
});

test("wall-clock limit preserves partial output, finalizes failed, and cancels", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  let wallClockHandler: (() => void) | undefined;
  const clearedTimers: unknown[] = [];
  const cancelledSessions: string[] = [];
  let finalizedResolve!: () => void;
  const finalized = new Promise<void>((resolve) => {
    finalizedResolve = resolve;
  });
  const timer = { unref() {} } as unknown as NodeJS.Timeout;
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => ({
      connection: {
        cancel: async ({ sessionId }: { sessionId: string }) => {
          cancelledSessions.push(sessionId);
        },
      },
    } as unknown as BrokerAgentHandle),
    hashRunPayload: () => "payload-hash",
    writeNotification(_socket, method) {
      if (method === "consult/finalized") finalizedResolve();
    },
    maxWallClockMs: 25,
    scheduleWallClock(handler, milliseconds) {
      assert.equal(milliseconds, 25);
      wallClockHandler = handler;
      return timer;
    },
    clearWallClock(value) {
      clearedTimers.push(value);
    },
  });
  const job = runtime.createJob(
    { jobId: "job-wall-limit", profile: "codex", mode: "read-only", prompt: "wait" },
    fakeSocket("originator"),
  );
  runtime.attachJob(job, fakeSocket("subscriber"));
  runtime.trackSession("session-wall-limit", job);
  await runtime.handleSessionUpdate({
    sessionId: "session-wall-limit",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial before timeout" },
    },
  });

  assert.ok(wallClockHandler);
  wallClockHandler!();
  await finalized;
  await waitFor(() => cancelledSessions.length === 1);

  assert.equal(job.status, "finalized");
  assert.equal(job.finalized?.stopReason, "failed");
  assert.match(job.finalized?.errorMessage ?? "", new RegExp(`^${JOB_WALL_CLOCK_LIMIT_EXCEEDED}:`));
  assert.equal(job.finalText, "partial before timeout");
  assert.deepEqual(cancelledSessions, ["session-wall-limit"]);
  assert.deepEqual(clearedTimers, [timer]);
  runtime.noteTurnSettled(job);
});

test("normal finalization clears the wall-clock guard", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const timer = { unref() {} } as unknown as NodeJS.Timeout;
  const clearedTimers: unknown[] = [];
  const runtime = createBrokerJobRuntime({
    config: {
      cwd: workspaceRoot,
      host: "terminal",
      hostSessionId: "default",
      cancelAckTimeoutMs: 2000,
    },
    ensureAgent: async () => { throw new Error("agent should not be needed"); },
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
    scheduleWallClock: () => timer,
    clearWallClock(value) {
      clearedTimers.push(value);
    },
  });
  const job = runtime.createJob(
    { jobId: "job-clear-wall", profile: "codex", mode: "read-only", prompt: "finish" },
    fakeSocket("originator"),
  );

  await runtime.finalizeJob(job, { stopReason: "end_turn", sessionId: "session-clear" });

  assert.deepEqual(clearedTimers, [timer]);
});

test("policy violation with an unsettled turn releases and taints after the cancel-ack timeout", async (t: TestContext) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const runtime = createBrokerJobRuntime({
    // The ack timeout must comfortably exceed the awaited record write inside
    // the violation path so the held-busy state is observable first.
    config: { cwd: workspaceRoot, host: "terminal", hostSessionId: "default", cancelAckTimeoutMs: 250 },
    ensureAgent: async () => ({ connection: { cancel: async () => {} } } as unknown as BrokerAgentHandle),
    hashRunPayload: () => "payload-hash",
    writeNotification() {},
  });
  const job = runtime.createJob(
    { jobId: "job-policy-unsettled", profile: "codex", mode: "read-only", prompt: "inspect" },
    fakeSocket("originator"),
  );
  runtime.trackSession("session-1", job);
  runtime.setBusy(true);

  await runtime.handleSessionUpdate({
    sessionId: "session-1",
    update: { sessionUpdate: "tool_call", rawInput: { auto_approved: true } },
  });

  assert.equal(job.status, "finalized");
  // The violated turn has not settled: busy is deliberately held until the
  // agent responds or the cancel-ack timer gives up.
  assert.equal(runtime.isBusy(), true);
  assert.equal(runtime.isTainted(), false);

  await waitFor(() => runtime.isTainted());
  assert.equal(runtime.isBusy(), false);
  assert.equal((await readWorkspaceJobRecord(workspaceRoot, job.jobId)).status, "failed");
});

interface FakeSocket extends BrokerJobSocketLike {
  name: string;
}

function fakeSocket(name: string): FakeSocket {
  return {
    name,
    once() {},
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-runtime-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
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
