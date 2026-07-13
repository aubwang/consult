import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "./review.mts";
import type { ReviewDeps } from "./review.mts";
import type { ProfileRecord } from "../profiles.mts";

test("review with codex profile calls the codex adapter", async () => {
  let adapterArgs: Record<string, unknown> | undefined;
  let diffCalls = 0;
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex", label: "security review" } },
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
  assert.equal(adapterArgs?.label, "security review");
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

test("nested generic review inherits its delegation lineage", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords: Array<Record<string, unknown>> = [];
  const resultPromise = runReview({
    args: { positional: [], flags: { agent: "claude" } },
    env: { CONSULT_PARENT_JOB: "job-parent" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      getDiff: async () => "pinned diff",
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-nested-review",
      readJobRecord: async () => ({
        jobId: "job-parent",
        status: "running",
        chainId: "job-root",
        delegationDepth: 0,
        mode: "write",
      }),
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        writtenRecords.push(structuredClone(record));
      },
      appendLogLine: async () => {},
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-nested-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(request.params.chainId, "job-root");
  assert.equal(request.params.parentJobId, "job-parent");
  assert.equal(request.params.delegationDepth, 1);
  assert.equal(writtenRecords[0]?.chainId, "job-root");
  assert.equal(writtenRecords[0]?.parentJobId, "job-parent");
});

test("review --job reviews a completed isolated Job artifact without reading the Host diff", async () => {
  const client = new FakeBrokerClient();
  const writtenRecords: Array<Record<string, unknown>> = [];
  let diffCalls = 0;
  const resultPromise = runReview({
    args: {
      positional: [],
      flags: { agent: "claude", job: "job-implementation", label: "artifact review" },
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      readJobRecord: async () => ({
        jobId: "job-implementation",
        label: "parser cleanup",
        kind: "delegate",
        status: "completed",
        isolated: true,
        prompt: "Implement the parser cleanup and test it.",
        finalText: "Status: DONE\nEvidence: focused tests pass.",
        patchPath: "/state/job-implementation/changes.patch",
        touchedFiles: ["src/parser.ts", "src/parser.test.ts"],
      }),
      readArtifact: async () => "diff --git a/src/parser.ts b/src/parser.ts\n+fixed();\n",
      getDiff: async () => {
        diffCalls += 1;
        return "wrong diff";
      },
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-artifact-review",
      writeJobRecord: async (_workspaceRoot, _jobId, record) => {
        writtenRecords.push(structuredClone(record));
      },
      appendLogLine: async () => {},
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-artifact-review",
    stopReason: "end_turn",
    sessionId: "session-review",
  });
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(diffCalls, 0);
  assert.equal(writtenRecords.at(0)?.reviewOfJobId, "job-implementation");
  assert.equal(writtenRecords.at(0)?.label, "artifact review");
  assert.match(request.params.prompt as string, /Implement the parser cleanup and test it\./u);
  assert.match(request.params.prompt as string, /Status: DONE/u);
  assert.match(request.params.prompt as string, /src\/parser\.test\.ts/u);
  assert.match(request.params.prompt as string, /\+fixed\(\);/u);
  assert.match(request.params.prompt as string, /UNTRUSTED CODE\/DATA/u);
});

test("review --job rejects incompatible sources before artifact or Profile execution", async () => {
  let artifactRead = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude", job: "job-in-place" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      readJobRecord: async () => ({
        jobId: "job-in-place",
        status: "completed",
        isolated: false,
      }),
      readArtifact: async () => {
        artifactRead = true;
        return "unexpected";
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /requires an isolated write Job/u);
  assert.equal(artifactRead, false);
});

test("review --job rejects a patch path outside Consult-owned Job state", async () => {
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude", job: "job-tampered" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => process.cwd(),
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      readJobRecord: async () => ({
        jobId: "job-tampered",
        status: "completed",
        isolated: true,
        patchPath: "/etc/passwd",
      }),
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /does not match Consult-owned isolated Job state/u);
});

test("review --job preflights authority before reading its patch artifact", async () => {
  let artifactRead = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude", job: "job-isolated" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      readJobRecord: async () => ({
        jobId: "job-isolated",
        status: "completed",
        isolated: true,
        patchPath: "/state/changes.patch",
      }),
      preflightAuthority: async () => ({
        ok: false,
        diagnostic: {
          code: "AUTHORITY_PREFLIGHT_FAILED",
          message: "review confinement unavailable",
          remediation: "Run Doctor.",
        },
      }),
      readArtifact: async () => {
        artifactRead = true;
        return "unexpected";
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(artifactRead, false);
  assert.match(result.stderr, /review confinement unavailable/u);
});

test("review rejects combining --job with --base before Workspace discovery", async () => {
  const result = await runReview({
    args: { positional: [], flags: { job: "job-one", base: "main" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--job and --base are mutually exclusive\n");
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

test("review fails authority preflight before diff capture or adapter work", async () => {
  let diffCalled = false;
  let adapterCalled = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex", json: true } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("codex"),
      preflightAuthority: async (input) => {
        assert.equal(input.profile, "codex");
        assert.equal(input.profileRegistryId, "codex");
        return {
          ok: false,
          diagnostic: {
            code: "AUTHORITY_COMBINATION_UNSUPPORTED",
            message: "confined review unavailable",
            remediation: "Use --sandbox inherit only if ambient authority is acceptable.",
          },
        };
      },
      getDiff: async () => {
        diffCalled = true;
        return "diff";
      },
      runCodexReview: async () => {
        adapterCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "AUTHORITY_COMBINATION_UNSUPPORTED");
  assert.equal(diffCalled, false);
  assert.equal(adapterCalled, false);
});

test("root Claude review automatically refreshes once before diff capture", async () => {
  let preflightCalls = 0;
  let refreshCalls = 0;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      preflightAuthority: async (input) => {
        preflightCalls += 1;
        return preflightCalls === 1
          ? expiredClaudePreflight()
          : { ok: true as const, authority: input.authority };
      },
      refreshClaudeHostOauth: async (input) => {
        assert.equal(input.profileRegistryId, "claude");
        refreshCalls += 1;
      },
      getDiff: async () => {
        throw new Error("stop after refresh proof");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /stop after refresh proof/u);
  assert.equal(preflightCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("nested Claude review never refreshes the Host credential", async () => {
  let refreshCalls = 0;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude" } },
    env: { CONSULT_PARENT_JOB: "job-parent" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
      preflightAuthority: async () => expiredClaudePreflight(),
      refreshClaudeHostOauth: async () => {
        refreshCalls += 1;
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(refreshCalls, 0);
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
    preflightAuthority: async (input) => ({
      ok: true,
      authority: input.authority,
    }),
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

function expiredClaudePreflight() {
  return {
    ok: false as const,
    diagnostic: {
      code: "AUTHORITY_PREFLIGHT_FAILED" as const,
      message: "Claude OAuth credential is expired",
      remediation: "Sign in.",
      details: {
        credentialKind: "claude-oauth",
        credentialState: "expired",
      },
    },
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
test("review rejects unsupported authority flags instead of silently narrowing them", async () => {
  const result = await runReview({
    args: { positional: [], flags: { "allow-fetch": true } },
    deps: { stdoutWrite: () => {}, stderrWrite: () => {} },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--allow-fetch is not supported by this command/u);
});
