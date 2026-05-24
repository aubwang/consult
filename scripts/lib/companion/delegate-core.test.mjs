import assert from "node:assert/strict";
import { test } from "node:test";

import { renderUpdate, runDelegateOnce, statusFromStopReason } from "./delegate-core.mjs";

test("renderUpdate passes agent message chunk text through unchanged", () => {
  assert.equal(
    renderUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello\n" },
    }),
    "hello\n",
  );
});

test("renderUpdate labels codex-shaped tool calls with kind and title", () => {
  assert.equal(
    renderUpdate({
      sessionUpdate: "tool_call",
      kind: "edit",
      title: "Edit inside.txt",
    }),
    "[tool_call edit: Edit inside.txt]\n",
  );
});

test("renderUpdate labels ACP-standard tool calls with toolCall name", () => {
  assert.equal(
    renderUpdate({
      sessionUpdate: "tool_call",
      toolCall: { name: "bash" },
    }),
    "[tool_call bash]\n",
  );
});

test("renderUpdate ignores tool call update status events", () => {
  assert.equal(renderUpdate({ sessionUpdate: "tool_call_update" }), "");
});

test("renderUpdate ignores unrecognized session update types", () => {
  assert.equal(renderUpdate({ sessionUpdate: "unknown_update" }), "");
});

test("renderUpdate labels nameless tool calls as unknown", () => {
  assert.equal(renderUpdate({ sessionUpdate: "tool_call" }), "[tool_call unknown]\n");
});

test("statusFromStopReason maps broker stop reasons to job statuses", () => {
  assert.equal(statusFromStopReason("end_turn"), "completed");
  assert.equal(statusFromStopReason("cancelled"), "cancelled");
  assert.equal(statusFromStopReason("failed"), "failed");
  // Unknown stop reasons intentionally fall through to completed status.
  assert.equal(statusFromStopReason("anything-unknown"), "completed");
});

test("runDelegateOnce persists finalized error messages for failed jobs", async () => {
  const client = new FakeBrokerClient();
  const persistedRecords = [];
  const jobRecord = {
    jobId: "job-failed",
    mode: "write",
    host: "claude-code",
    profile: "codex",
    hostSessionId: "claude-1",
    submittedAt: "2026-05-14T10:00:00.000Z",
    prompt: "fix failure",
  };

  const resultPromise = runDelegateOnce({
    workspaceRoot: "/tmp/consult-test-workspace",
    profileEntry: {},
    jobRecord,
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        persistedRecords.push(structuredClone(record));
      },
      now: () => "2026-05-14T10:00:01.000Z",
    },
    renderSummary: false,
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-failed",
    stopReason: "failed",
    sessionId: "session-failed",
    errorMessage: "test error",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  const persistedRecord = persistedRecords.at(-1);
  assert.equal(persistedRecord.status, "failed");
  assert.equal(persistedRecord.errorMessage, "test error");
  assert.equal(jobRecord.status, "failed");
  assert.equal(jobRecord.errorMessage, "test error");
});

test("runDelegateOnce fails the job when the broker disconnects after accepting it", async () => {
  const client = new FakeBrokerClient();
  const persistedRecords = [];
  const jobRecord = {
    jobId: "job-disconnected",
    mode: "write",
    host: "claude-code",
    profile: "codex",
    hostSessionId: "claude-1",
    submittedAt: "2026-05-14T10:00:00.000Z",
    prompt: "survive broker crash",
  };

  const resultPromise = runDelegateOnce({
    workspaceRoot: "/tmp/consult-test-workspace",
    profileEntry: {},
    jobRecord,
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        persistedRecords.push(structuredClone(record));
      },
      now: () => "2026-05-14T10:00:01.000Z",
    },
    renderSummary: false,
  });

  await client.waitForRequest("consult/run");
  client.disconnect(
    Object.assign(new Error("Broker disconnected"), { code: "BROKER_DISCONNECTED" }),
  );
  const result = await resultPromise;

  assert.equal(result.exitCode, 1);
  const persistedRecord = persistedRecords.at(-1);
  assert.equal(persistedRecord.status, "failed");
  assert.equal(
    persistedRecord.errorMessage,
    "BROKER_DISCONNECTED: Broker disconnected. Inspect Broker state with `consult brokers`; remove stale state with `consult brokers --cleanup`.",
  );
  assert.equal(jobRecord.status, "failed");
  assert.equal(
    jobRecord.errorMessage,
    "BROKER_DISCONNECTED: Broker disconnected. Inspect Broker state with `consult brokers`; remove stale state with `consult brokers --cleanup`.",
  );
});

class FakeBrokerClient {
  #closeHandlers = new Set();
  #handlers = new Map();
  #requests = new Map();
  #requestResolvers = new Map();

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async request(method, params) {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    return { accepted: true, jobId: params.jobId };
  }

  disconnect(error) {
    for (const handler of this.#closeHandlers) {
      handler(error);
    }
  }

  notify(method, params) {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method) {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method));
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }
}
