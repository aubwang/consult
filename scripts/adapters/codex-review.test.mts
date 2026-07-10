import assert from "node:assert/strict";
import { test } from "node:test";

import { runCodexReview } from "./codex-review.mts";
import type { CodexReviewDeps } from "./codex-review.mts";
import type { JobRecord } from "../lib/job-records.mts";

test("runCodexReview streams a codex review when review is advertised", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords: unknown[] = [];
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
      writeJobRecord: async (_workspaceRoot: string, _jobId: string, record: JobRecord) => {
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
  assert.equal((request.params as Record<string, unknown>).kind, "review");
  assert.match(
    (request.params as Record<string, unknown>).prompt as string,
    /^\/review\n\n--- BEGIN CONSULT PINNED GIT DIFF/,
  );
  assert.match((request.params as Record<string, unknown>).prompt as string, /diff text/);
  assert.match(
    (request.params as Record<string, unknown>).prompt as string,
    /--- END CONSULT PINNED GIT DIFF ---$/,
  );
  assert.equal((request.params as Record<string, unknown>).chainId, "job-review");
  assert.equal((request.params as Record<string, unknown>).parentJobId, null);
  assert.equal((request.params as Record<string, unknown>).delegationDepth, 0);
  assert.equal((writtenRecords.at(0) as Record<string, unknown>).chainId, "job-review");
  assert.equal((writtenRecords.at(0) as Record<string, unknown>).parentJobId, null);
  assert.equal((writtenRecords.at(0) as Record<string, unknown>).delegationDepth, 0);
  assert.equal((writtenRecords.at(0) as Record<string, unknown>).includeDiff, true);
  assert.equal((writtenRecords.at(0) as Record<string, unknown>).prompt, "/review");
  assert.equal(result.stdout, "review output\nconsult review job-review completed\n");
});

test("runCodexReview emits the versioned Job envelope with --json", async () => {
  const client = new FakeBrokerClient();
  const resultPromise = runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: process.cwd(),
    host: "terminal",
    hostSessionId: "default",
    diff: "already pinned",
    json: true,
    deps: quietDeps({
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-review-json",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", availableCommandsUpdate(["review"]));
  client.notify("consult/update", agentTextUpdate("json review"));
  client.notify("consult/finalized", {
    jobId: "job-review-json",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.job.id, "job-review-json");
  assert.equal(parsed.job.kind, "review");
  assert.equal(parsed.outcome.finalText, "json review");
});

test("runCodexReview uses a supplied pinned snapshot without recapturing it", async () => {
  const client = new FakeBrokerClient();
  const resultPromise = runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "terminal",
    hostSessionId: "default",
    diff: "already pinned",
    deps: quietDeps({
      getDiff: async () => {
        throw new Error("getDiff should not run");
      },
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
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
});

test("runCodexReview exits 6 when the review turn finalizes as failed", async () => {
  const client = new FakeBrokerClient();
  const resultPromise = runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "terminal",
    hostSessionId: "default",
    diff: "already pinned",
    deps: quietDeps({
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-review-failed",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", availableCommandsUpdate(["review"]));
  client.notify("consult/finalized", {
    jobId: "job-review-failed",
    stopReason: "failed",
    sessionId: "session-review",
  });

  assert.equal((await resultPromise).exitCode, 6);
});

test("runCodexReview returns a clean error when diff capture fails", async () => {
  let generated = false;
  const result = await runCodexReview({
    profile: "codex",
    profileEntry: profileEntryFixture(),
    workspaceRoot: "/workspace",
    host: "terminal",
    hostSessionId: "default",
    baseRef: "missing",
    deps: quietDeps({
      getDiff: async () => {
        throw new Error("base ref is missing");
      },
      generateJobId: () => {
        generated = true;
        return "should-not-exist";
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unable to capture pinned git diff/);
  assert.equal(generated, false);
});

test("runCodexReview exits 8 and cancels the accepted job when the slash is not advertised", async () => {
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

  assert.equal(result.exitCode, 8);
  assert.equal(
    result.stderr,
    "codex did not advertise /review; the codex-acp version may not support it\n",
  );
  const cancelRequest = await client.waitForRequest("consult/cancel");
  assert.deepEqual(cancelRequest.params, { jobId: "job-review" });
});

test("runCodexReview passes baseRef to getDiff when provided", async () => {
  let diffArgs: unknown;
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
  let diffArgs: unknown;
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
  #handlers = new Map<string, (params: unknown) => void>();
  #requests = new Map<string, { method: string; params: unknown }>();
  #requestResolvers = new Map<string, (req: { method: string; params: unknown }) => void>();

  on(method: string, handler: (params: unknown) => void): void {
    this.#handlers.set(method, handler);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    return { accepted: true, jobId: (params as Record<string, unknown>).jobId };
  }

  notify(method: string, params: unknown): void {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method: string): Promise<{ method: string; params: unknown }> {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method)!);
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }
}

function quietDeps(deps: Partial<CodexReviewDeps>): CodexReviewDeps {
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

function availableCommandsUpdate(names: string[]) {
  return {
    jobId: "job-review",
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: names.map((name) => ({ name, description: `${name} command` })),
    },
  };
}

function agentTextUpdate(text: string) {
  return {
    jobId: "job-review",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

async function completedReview({
  baseRef = null,
  getDiff,
}: {
  baseRef?: string | null;
  getDiff: (args: unknown) => Promise<string>;
}) {
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
