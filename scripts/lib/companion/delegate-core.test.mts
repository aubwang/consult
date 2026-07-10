import assert from "node:assert/strict";
import { test } from "node:test";

import type { PreparedIsolatedWorkspace } from "../isolated-workspace.mts";
import { renderUpdate, runDelegateOnce, statusFromStopReason } from "./delegate-core.mts";

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

test("runDelegateOnce can identify a non-delegate job kind", async () => {
  const client = new FakeBrokerClient();
  let stdout = "";
  const resultPromise = runDelegateOnce({
    workspaceRoot: "/tmp/consult-test-workspace",
    profileEntry: {},
    jobRecord: {
      jobId: "job-review",
      kind: "review",
      mode: "read-only",
      host: "terminal",
      profile: "codex",
      prompt: "review this",
    },
    kind: "review",
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async () => {},
    },
    output: {
      stdout(text) {
        stdout += text;
      },
      stderr() {},
      result(exitCode) {
        return { exitCode, stdout, stderr: "" };
      },
    },
  });

  const request = await client.waitForRequest("consult/run");
  assert.equal(request.params.kind, "review");
  client.notify("consult/finalized", {
    jobId: "job-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  assert.equal((await resultPromise).exitCode, 0);
  assert.equal(stdout, "consult review job-review completed\n");
});

test("runDelegateOnce cleans isolation and fails the job when artifact finalization fails", async () => {
  const client = new FakeBrokerClient();
  const prepared = isolatedFixture();
  const records: Array<Record<string, unknown>> = [];
  let cleanupCalls = 0;
  const jobRecord = {
    jobId: "job-isolation-failure",
    kind: "delegate",
    mode: "write",
    host: "terminal",
    hostSessionId: "terminal-1",
    profile: "codex",
    prompt: "change",
    isolated: true,
    isolatedWorkspace: prepared,
  };
  const resultPromise = runDelegateOnce({
    workspaceRoot: prepared.workspaceRoot,
    executionRoot: prepared.executionRoot,
    profileEntry: {},
    jobRecord,
    isolatedWorkspace: prepared,
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        records.push(structuredClone(record));
      },
      finalizeIsolatedWorkspace: async () => {
        throw new Error("cannot create patch");
      },
      cleanupIsolatedWorkspace: async () => {
        cleanupCalls += 1;
      },
    },
    renderSummary: false,
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-isolation-failure",
    stopReason: "end_turn",
    sessionId: "session-isolation-failure",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 6);
  assert.equal(cleanupCalls, 1);
  assert.equal(records.at(-1)?.status, "failed");
  assert.match(String(records.at(-1)?.errorMessage), /cannot create patch/);
});

test("runDelegateOnce persists finalized error messages for failed jobs", async () => {
  const client = new FakeBrokerClient();
  const persistedRecords: unknown[] = [];
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

  // A turn that finalized as failed exits 6 per the operational contract.
  assert.equal(result.exitCode, 6);
  const persistedRecord = persistedRecords.at(-1) as Record<string, unknown>;
  assert.equal(persistedRecord.status, "failed");
  assert.equal(persistedRecord.errorMessage, "test error");
  assert.equal((jobRecord as Record<string, unknown>).status, "failed");
  assert.equal((jobRecord as Record<string, unknown>).errorMessage, "test error");
});

test("runDelegateOnce fails the job when the broker disconnects after accepting it", async () => {
  const client = new FakeBrokerClient();
  const persistedRecords: unknown[] = [];
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
  const persistedRecord = persistedRecords.at(-1) as Record<string, unknown>;
  assert.equal(persistedRecord.status, "failed");
  assert.equal(
    persistedRecord.errorMessage,
    "BROKER_DISCONNECTED: Broker disconnected. Inspect Broker state with `consult brokers`; remove stale state with `consult brokers --cleanup`.",
  );
  assert.equal((jobRecord as Record<string, unknown>).status, "failed");
  assert.equal(
    (jobRecord as Record<string, unknown>).errorMessage,
    "BROKER_DISCONNECTED: Broker disconnected. Inspect Broker state with `consult brokers`; remove stale state with `consult brokers --cleanup`.",
  );
});

type NotificationHandler = (params: Record<string, unknown>) => void;
type CloseHandler = (error: Error) => void;
type RequestResolver = (value: { method: string; params: Record<string, unknown> }) => void;

class FakeBrokerClient {
  #closeHandlers = new Set<CloseHandler>();
  #handlers = new Map<string, NotificationHandler>();
  #requests = new Map<string, { method: string; params: Record<string, unknown> }>();
  #requestResolvers = new Map<string, RequestResolver>();

  on(method: string, handler: NotificationHandler): void {
    this.#handlers.set(method, handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async request(method: string, params: Record<string, unknown>): Promise<{ accepted: boolean; jobId: unknown }> {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    return { accepted: true, jobId: params.jobId };
  }

  disconnect(error: Error): void {
    for (const handler of this.#closeHandlers) {
      handler(error);
    }
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method: string): Promise<{ method: string; params: Record<string, unknown> }> {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method) as { method: string; params: Record<string, unknown> });
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }
}

function isolatedFixture(): PreparedIsolatedWorkspace {
  return {
    schemaVersion: 1,
    jobId: "job-isolation-failure",
    workspaceRoot: "/tmp/original-workspace",
    executionRoot: "/tmp/isolated-worktree",
    transactionRoot: "/tmp/isolated-transaction",
    artifactsDir: "/tmp/isolated-transaction/artifacts",
    cleanupMetadataPath: "/tmp/isolated-transaction/artifacts/cleanup.json",
    headCommit: "a".repeat(40),
    baselineTree: "b".repeat(40),
    preparedAt: "2026-07-09T10:00:00.000Z",
    maxBufferBytes: 1024,
    seeded: { stagedPatchBytes: 0, unstagedPatchBytes: 0, untrackedFiles: [] },
  };
}
