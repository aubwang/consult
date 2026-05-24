import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodexReview } from "./codex-review.mjs";

test("runCodexReview streams a codex review when review is advertised", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords = [];
  const resultPromise = runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "claude-code",
    hostSessionId: "claude-1",
    deps: quietDeps({
      getDiff: async () => "diff text",
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-review",
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        writtenRecords.push(structuredClone(record));
      },
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/update", availableCommandsUpdate(["review"]));
  client.notify("consult/update", agentTextUpdate("review output"));
  client.notify("consult/finalized", {
    jobId: "job-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(request.params.kind, "review");
  assert.equal(request.params.prompt, "/review\n\ndiff text");
  assert.equal(request.params.chainId, "job-review");
  assert.equal(request.params.parentJobId, null);
  assert.equal(request.params.delegationDepth, 0);
  assert.equal(writtenRecords.at(0).chainId, "job-review");
  assert.equal(writtenRecords.at(0).parentJobId, null);
  assert.equal(writtenRecords.at(0).delegationDepth, 0);
  assert.equal(result.stdout, "review output");
});

test("runCodexReview exits 4 when the slash is not advertised before timeout", async () => {
  const client = new FakeBrokerClient();
  const result = await runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "claude-code",
    hostSessionId: "claude-1",
    deps: quietDeps({
      getDiff: async () => "diff text",
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-review",
      availableCommandsTimeoutMs: 100,
    }),
  });

  assert.equal(result.exitCode, 4);
  assert.equal(
    result.stderr,
    "codex did not advertise /review; the codex-acp version may not support it\n",
  );
});

test("runCodexReview passes baseRef to getDiff when provided", async () => {
  let diffArgs;
  const result = await completedReview({
    baseRef: "origin/main",
    getDiff: async (args) => {
      diffArgs = args;
      return "base diff";
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(diffArgs, { baseRef: "origin/main", cwd: "/workspace" });
});

test("runCodexReview calls getDiff without baseRef in working-tree mode", async () => {
  let diffArgs;
  const result = await completedReview({
    getDiff: async (args) => {
      diffArgs = args;
      return "working diff";
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(diffArgs, { cwd: "/workspace" });
});

class FakeBrokerClient {
  #handlers = new Map();
  #requests = new Map();
  #requestResolvers = new Map();

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  async request(method, params) {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    return { accepted: true, jobId: params.jobId };
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

function quietDeps(deps) {
  return {
    stdoutWrite: () => {},
    stderrWrite: () => {},
    now: () => "2026-05-15T00:00:00.000Z",
    writeJobRecord: async () => {},
    appendLogLine: async () => {},
    ...deps,
  };
}

function profileEntryFixture() {
  return {
    registryId: "codex",
    binary: "/bin/codex-acp",
    args: [],
    env: {},
    installedAt: "2026-05-14T09:00:00.000Z",
  };
}

function availableCommandsUpdate(names) {
  return {
    jobId: "job-review",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: names.map((name) => ({ name, description: `${name} command` })),
    },
  };
}

function agentTextUpdate(text) {
  return {
    jobId: "job-review",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

async function completedReview({ baseRef = null, getDiff }) {
  const client = new FakeBrokerClient();
  const resultPromise = runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "claude-code",
    hostSessionId: "claude-1",
    baseRef,
    deps: quietDeps({
      getDiff,
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-review",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", availableCommandsUpdate(["review"]));
  client.notify("consult/finalized", {
    jobId: "job-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  return resultPromise;
}
