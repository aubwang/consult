import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { createBrokerJobRuntime } from "./broker-job-runtime.mts";
import type { BrokerAgentHandle, BrokerJobSocketLike } from "./broker-job-runtime.mts";
import { TEXT_TRUNCATED_MARKER } from "./bounded-text.mts";

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
  runtime.trackSession("session-1", job, "write");

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
  runtime.trackSession("session-1", job, "write");

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
    ensureAgent: async (mode?: string) => {
      modes.push(mode);
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
  runtime.trackSession("session-1", job, "write");

  await runtime.cancelJob(job);

  // A bare ensureAgent() would default to read-only and restart a sandboxed
  // write-mode agent mid-turn instead of cancelling on the live one.
  assert.deepEqual(modes, ["write"]);
  assert.deepEqual(cancelledSessions, ["session-1"]);
  await runtime.finalizeJob(job, { stopReason: "cancelled", sessionId: "session-1" });
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
