import assert from "node:assert/strict";
import { test } from "node:test";

import { TEXT_TRUNCATED_MARKER } from "./bounded-text.mts";
import { runPromptTurn } from "./prompt-turn-runner.mts";

interface CapturedRequest {
  method: string;
  params: Record<string, unknown>;
}

test("runPromptTurn streams updates, writes logs, and finalizes the job record", async () => {
  const client = new FakeBrokerClient();
  const logs: Array<{ jobId: string; notification: { method: string } }> = [];
  const records: Array<{ jobId: string; record: Record<string, unknown> }> = [];
  let brokerInput: Record<string, unknown> | undefined;
  const output = createOutput();
  const jobRecord = {
    jobId: "job-turn",
    kind: "review",
    mode: "read-only",
    host: "codex",
    hostSessionId: "thread-1",
    profile: "codex",
    submittedAt: "2026-05-21T10:00:00.000Z",
    chainId: "job-turn",
    parentJobId: null,
    delegationDepth: 0,
  };

  const resultPromise = runPromptTurn({
    workspaceRoot: "/workspace",
    profileEntry: {},
    jobRecord,
    prompt: "/review\n\ndiff",
    payloadFields: { baseRef: "origin/main" },
    deps: {
      ensureBrokerSession: async (input) => {
        brokerInput = input as unknown as Record<string, unknown>;
        return { client };
      },
      appendLogLine: async (_workspaceRoot, jobId, notification) => {
        logs.push({ jobId, notification: notification as { method: string } });
      },
      writeJobRecord: async (_workspaceRoot, jobId, record) => {
        records.push({ jobId, record: structuredClone(record) });
      },
      now: () => "2026-05-21T10:01:00.000Z",
    },
    output,
    renderUpdate(notification) {
      const update = (notification as any).update ?? notification;
      return update.content?.text ?? "";
    },
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/update", {
    jobId: "job-turn",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "review text" },
    },
  });
  client.notify("consult/finalized", {
    jobId: "job-turn",
    stopReason: "end_turn",
    sessionId: "session-turn",
  });
  const result = (await resultPromise) as any;

  assert.equal(result.finalText, "review text");
  assert.equal(output.captured.stdout, "review text");
  assert.deepEqual(request.params, {
    jobId: "job-turn",
    kind: "review",
    mode: "read-only",
    host: "codex",
    hostSessionId: "thread-1",
    profile: "codex",
    submittedAt: "2026-05-21T10:00:00.000Z",
    chainId: "job-turn",
    parentJobId: null,
    delegationDepth: 0,
    resume: null,
    prompt: "/review\n\ndiff",
    baseRef: "origin/main",
  });
  assert.deepEqual(
    logs.map((entry) => entry.notification.method),
    ["consult/update", "consult/finalized"],
  );
  assert.equal(records.at(0)!.record.status, "running");
  assert.equal(records.at(-1)!.record.status, "completed");
  assert.equal(records.at(-1)!.record.sessionId, "session-turn");
  assert.equal(records.at(-1)!.record.finalText, "review text");
  assert.equal(brokerInput!.jobId, "job-turn");
});

test("runPromptTurn lets a variant stop after broker acceptance", async () => {
  const client = new FakeBrokerClient();
  const output = createOutput();

  const result = (await runPromptTurn({
    workspaceRoot: "/workspace",
    profileEntry: {},
    jobRecord: {
      jobId: "job-variant",
      kind: "review",
      mode: "read-only",
      host: "codex",
      hostSessionId: "thread-1",
      profile: "codex",
      submittedAt: "2026-05-21T10:00:00.000Z",
    },
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async () => {},
    },
    output,
    afterAccepted: async () => {
      output.stderr("variant rejected\n");
      return output.result(4);
    },
  })) as any;

  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, "variant rejected\n");
  assert.ok(await client.waitForRequest("consult/run"));
});

test("runPromptTurn caps persisted final text while still streaming updates", async () => {
  const client = new FakeBrokerClient();
  const records: Array<Record<string, unknown>> = [];
  const output = createOutput();

  const resultPromise = runPromptTurn({
    workspaceRoot: "/workspace",
    profileEntry: {},
    jobRecord: {
      jobId: "job-long",
      kind: "review",
      mode: "read-only",
      host: "codex",
      hostSessionId: "thread-1",
      profile: "codex",
      submittedAt: "2026-05-21T10:00:00.000Z",
    },
    deps: {
      ensureBrokerSession: async () => ({ client }),
      appendLogLine: async () => {},
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        records.push(structuredClone(record));
      },
      maxFinalTextChars: 40,
    },
    output,
    renderUpdate(notification) {
      const update = (notification as any).update ?? notification;
      return update.content?.text ?? "";
    },
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", {
    jobId: "job-long",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    },
  });
  client.notify("consult/finalized", {
    jobId: "job-long",
    stopReason: "end_turn",
    sessionId: "session-long",
  });
  const result = (await resultPromise) as any;

  assert.equal(result.finalText, `abcdefg${TEXT_TRUNCATED_MARKER}`);
  assert.equal(records.at(-1)!.finalText, `abcdefg${TEXT_TRUNCATED_MARKER}`);
  assert.equal(output.captured.stdout, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
});

class FakeBrokerClient {
  #handlers = new Map<string, (params: unknown) => void>();
  #requests = new Map<string, CapturedRequest>();
  #requestResolvers = new Map<string, (request: CapturedRequest) => void>();

  on(method: string, handler: (params: unknown) => void) {
    this.#handlers.set(method, handler);
  }

  async request(method: string, params: Record<string, unknown>) {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    return { accepted: true, jobId: params.jobId };
  }

  notify(method: string, params: unknown) {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method: string): Promise<CapturedRequest> {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method)!);
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }
}

function createOutput() {
  let stdout = "";
  let stderr = "";
  return {
    captured: {
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    },
    stdout(text: string) {
      stdout += text;
    },
    stderr(text: string) {
      stderr += text;
    },
    result(exitCode: number) {
      return { exitCode, stdout, stderr };
    },
  };
}
