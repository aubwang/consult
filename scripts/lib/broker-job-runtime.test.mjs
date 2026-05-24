import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createBrokerJobRuntime } from "./broker-job-runtime.mjs";

test("broker job runtime buffers updates and notifies subscribers on finalize", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const notifications = [];
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
    writeNotification(socket, method, params) {
      notifications.push({ socket: socket.name, method, params });
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
  assert.equal(notifications.at(0).params.update.content.text, "hello");
  assert.equal(notifications.at(1).params.stopReason, "end_turn");
  assert.equal(job.finalText, "hello");
});

function fakeSocket(name) {
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

function withDataDir(t, dataDir) {
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
