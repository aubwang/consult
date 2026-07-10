import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "./review.mts";
import type { ReviewDeps } from "./review.mts";
import type { ProfileRecord } from "../profiles.mts";

test("review with codex profile calls the codex adapter", async () => {
  let adapterArgs: Record<string, unknown> | undefined;
  let diffCalls = 0;
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("codex"),
      getDiff: async () => {
        diffCalls += 1;
        return "pinned diff";
      },
      runCodexReview: async (args) => {
        adapterArgs = args as Record<string, unknown>;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(adapterArgs?.profile, "codex");
  assert.equal(adapterArgs?.workspaceRoot, "/workspace");
  assert.equal(adapterArgs?.host, "claude-code");
  assert.equal(adapterArgs?.hostSessionId, "claude-1");
  assert.equal(adapterArgs?.kind, "review");
  assert.equal(adapterArgs?.diff, "pinned diff");
  assert.equal(diffCalls, 1);
});

test("review with a Profile lacking native review runs a read-only pinned-diff Job", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords: Array<Record<string, unknown>> = [];
  let diffCalls = 0;
  const resultPromise = runReview({
    args: { positional: [], flags: { agent: "claude" } },
    env: { CONSULT_HOST: "codex", CONSULT_HOST_SESSION_ID: "codex-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      getDiff: async () => {
        diffCalls += 1;
        return "diff --git a/a.ts b/a.ts\n+broken();\n";
      },
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-generic-review",
      now: () => "2026-07-09T10:00:00.000Z",
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        writtenRecords.push(structuredClone(record));
      },
      appendLogLine: async () => {},
      runCodexReview: async () => {
        throw new Error("native adapter should not run");
      },
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("P1 finding"));
  client.notify("consult/finalized", {
    jobId: "job-generic-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.stdout,
    "P1 finding\nconsult review job-generic-review completed\n",
  );
  assert.equal(diffCalls, 1);
  assert.equal(request.params.kind, "review");
  assert.equal(request.params.mode, "read-only");
  assert.equal(request.params.profile, "claude");
  assert.match(request.params.prompt as string, /Return findings first, ordered by severity/);
  assert.match(request.params.prompt as string, /BEGIN CONSULT PINNED GIT DIFF/);
  assert.match(request.params.prompt as string, /\+broken\(\);/);
  const queued = writtenRecords.at(0)!;
  assert.equal(queued.kind, "review");
  assert.equal(queued.mode, "read-only");
  assert.equal(queued.includeDiff, true);
  assert.equal((queued.prompt as string).includes("diff --git"), false);
});

test("generic review pins the requested base and records its metadata", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords: Array<Record<string, unknown>> = [];
  let diffArgs: unknown;
  const resultPromise = runReview({
    args: { positional: [], flags: { agent: "opencode", base: "origin/main" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("opencode"),
      getDiff: async (args) => {
        diffArgs = args;
        return "base diff";
      },
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-base-review",
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        writtenRecords.push(structuredClone(record));
      },
      appendLogLine: async () => {},
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-base-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.deepEqual(diffArgs, { baseRef: "origin/main", cwd: "/workspace" });
  assert.equal(writtenRecords.at(0)?.baseRef, "origin/main");
  assert.equal(writtenRecords.at(0)?.includeDiff, true);
});

test("review reports diff capture errors before creating a Job", async () => {
  let generated = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude", base: "missing" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      getDiff: async () => {
        throw new Error("base ref 'missing' does not resolve to a commit");
      },
      generateJobId: () => {
        generated = true;
        return "should-not-exist";
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unable to capture pinned git diff/);
  assert.match(result.stderr, /does not resolve to a commit/);
  assert.equal(generated, false);
});

test("review reads advertisesReview from the registry instead of hardcoding codex", async () => {
  let adapterRan = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      getDiff: async () => "diff",
      loadRegistry: async () => ({
        schemaVersion: 1,
        agents: [
          {
            id: "claude",
            label: "Claude",
            binary: "claude-agent-acp",
            args: [],
            install: { type: "npm" as const, cmd: "npm install -g x" },
            supports: { resume: true, load: true },
            advertisesReview: true,
          },
        ],
      }),
      runCodexReview: async () => {
        adapterRan = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(adapterRan, true);
});

test("review exits 2 when --agent is passed without a value", async () => {
  const result = await runReview({
    args: { positional: [], flags: { agent: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
      runCodexReview: async () => {
        throw new Error("adapter should not run");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--agent requires a value\n");
});

test("review exits 2 when profiles are malformed", async () => {
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadProfiles: async () => {
        const error = Object.assign(new Error("Profiles file is malformed"), {
          code: "PROFILES_MALFORMED",
          path: "/tmp/profiles.json",
        });
        throw error;
      },
      runCodexReview: async () => {
        throw new Error("adapter should not run");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "profiles malformed: /tmp/profiles.json\n");
});

test("review exits 2 when the workspace override is malformed", async () => {
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadProfiles: async () => profilesFixture("codex"),
      loadOverride: async () => {
        const error = Object.assign(new Error("Workspace override file is malformed"), {
          code: "WORKSPACE_OVERRIDE_MALFORMED",
          path: "/tmp/override.json",
        });
        throw error;
      },
      runCodexReview: async () => {
        throw new Error("adapter should not run");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "workspace override malformed: /tmp/override.json\n");
});

function quietDeps(deps: ReviewDeps): ReviewDeps {
  return {
    ...deps,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  };
}

function profilesFixture(defaultProfile: string): {
  schemaVersion: number;
  default: string;
  profiles: Record<string, ProfileRecord>;
} {
  return {
    schemaVersion: 1,
    default: defaultProfile,
    profiles: {
      codex: profileEntry("codex"),
      claude: profileEntry("claude"),
      opencode: profileEntry("opencode"),
    },
  };
}

function profileEntry(registryId: string): ProfileRecord {
  return {
    registryId,
    binary: `/bin/${registryId}`,
    args: [],
    env: {},
    installedAt: "2026-05-14T09:00:00.000Z",
  };
}

interface BrokerRequest {
  method: string;
  params: Record<string, unknown>;
}

class FakeBrokerClient {
  #handlers = new Map<string, (params: Record<string, unknown>) => void>();
  #requests = new Map<string, BrokerRequest>();
  #requestResolvers = new Map<string, (request: BrokerRequest) => void>();

  on(method: string, handler: (params: Record<string, unknown>) => void) {
    this.#handlers.set(method, handler);
  }

  async request(method: string, params: Record<string, unknown>) {
    const request = { method, params };
    this.#requests.set(method, request);
    this.#requestResolvers.get(method)?.(request);
    return { accepted: true, jobId: params.jobId };
  }

  notify(method: string, params: Record<string, unknown>) {
    this.#handlers.get(method)?.(params);
  }

  waitForRequest(method: string): Promise<BrokerRequest> {
    if (this.#requests.has(method)) {
      return Promise.resolve(this.#requests.get(method)!);
    }
    return new Promise((resolve) => {
      this.#requestResolvers.set(method, resolve);
    });
  }
}

function agentTextUpdate(text: string) {
  return {
    jobId: "job-generic-review",
    sessionId: "session-review",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}
