import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import type { JobAuthority } from "../job-authority.mts";
import type {
  FinalizedIsolatedWorkspace,
  PreparedIsolatedWorkspace,
} from "../isolated-workspace.mts";
import { companionCliPath, runDelegate } from "./delegate.mts";
import type { DelegateDeps } from "./delegate.mts";

test("background worker entrypoint follows the executing module extension", () => {
  assert.equal(
    path.basename(
      companionCliPath("file:///tmp/consult/scripts/lib/companion/delegate.mts"),
    ),
    "consult-companion.mts",
  );
  assert.equal(
    path.basename(
      companionCliPath("file:///tmp/consult/dist/scripts/lib/companion/delegate.mjs"),
    ),
    "consult-companion.mjs",
  );
});

test("delegate streams agent text and finalizes the job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["fix", "the", "bug"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: fixedClock(["2026-05-14T10:00:00.000Z", "2026-05-14T10:00:01.000Z"]),
      generateJobId: () => "job-happy",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("hello "));
  client.notify("consult/update", agentTextUpdate("world"));
  client.notify("consult/finalized", {
    jobId: "job-happy",
    stopReason: "end_turn",
    sessionId: "session-1",
  });

  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello world/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-happy.json"), "utf8"),
  );
  assert.equal(record.status, "completed");
  assert.equal(record.host, "claude-code");
  assert.equal(record.hostSessionId, "claude-1");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.mode, "read-only");
  assert.deepEqual(record.authority, {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "confined",
    allowFetch: false,
    allowExecute: false,
  });
  assert.equal(record.chainId, "job-happy");
  assert.equal(record.parentJobId, null);
  assert.equal(record.delegationDepth, 0);
  assert.equal(record.finalText, "hello world");
  assert.equal(request.params.mode, "read-only");
  assert.deepEqual(request.params.authority, record.authority);
  assert.equal(request.params.chainId, "job-happy");
  assert.equal(request.params.parentJobId, null);
  assert.equal(request.params.delegationDepth, 0);
});

test("delegate honors explicit write mode", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["edit", "the", "bug"], flags: { write: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-write",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-write",
    stopReason: "end_turn",
    sessionId: "session-write",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-write.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.mode, "write");
  assert.equal(record.authority.mode, "write");
  assert.equal(record.authority.confinement, "confined");
  assert.equal(request.params.mode, "write");
});

test("delegate isolated write runs in the detached root and exposes finalized artifacts", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  const prepared = isolatedFixture(workspaceRoot, "job-isolated");
  let ensureInput: Record<string, unknown> | undefined;
  let cleanupCalls = 0;

  const resultPromise = runDelegate({
    args: {
      positional: ["make", "a", "transactional", "change"],
      flags: { write: true, isolated: true, json: true },
    },
    env: {
      CONSULT_HOST: "terminal",
      CONSULT_HOST_SESSION_ID: "terminal-1",
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      generateJobId: () => "job-isolated",
      prepareIsolatedWorkspace: async () => prepared,
      ensureBrokerSession: async (input: Record<string, unknown>) => {
        ensureInput = input;
        return { client };
      },
      finalizeIsolatedWorkspace: async () => finalizedIsolation(prepared),
      cleanupIsolatedWorkspace: async () => {
        cleanupCalls += 1;
        return {};
      },
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("changed"));
  client.notify("consult/finalized", {
    jobId: "job-isolated",
    stopReason: "end_turn",
    sessionId: "session-isolated",
  });
  const result = await resultPromise;
  const request = await client.waitForRequest("consult/run");
  const envelope = JSON.parse(result.stdout);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-isolated.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(ensureInput?.workspaceRoot, workspaceRoot);
  assert.equal(ensureInput?.executionRoot, prepared.executionRoot);
  assert.equal(request.params.allowExecute, undefined);
  assert.equal(record.isolated, true);
  assert.equal(record.allowExecute, false);
  assert.equal(record.patchPath, `${prepared.artifactsDir}/changes.patch`);
  assert.deepEqual(record.touchedFiles, ["src/changed.mts"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(envelope.job.isolated, true);
  assert.equal(envelope.job.allowExecute, false);
  assert.equal(envelope.artifacts.patchPath, `${prepared.artifactsDir}/changes.patch`);
  assert.deepEqual(envelope.artifacts.touchedFiles, ["src/changed.mts"]);
});

test("delegate validates isolated and execute opt-ins before workspace discovery", async () => {
  const neverResolveWorkspace = async () => {
    throw new Error("workspace should not be resolved");
  };
  const isolatedWithoutWrite = await runDelegate({
    args: { positional: ["fix"], flags: { isolated: true } },
    deps: quietDeps({ resolveWorkspaceRoot: neverResolveWorkspace }),
  });
  const executeWithoutIsolation = await runDelegate({
    args: { positional: ["fix"], flags: { write: true, "allow-exec": true } },
    env: { CONSULT_AGENT_SANDBOX: "bwrap" },
    deps: quietDeps({ resolveWorkspaceRoot: neverResolveWorkspace }),
  });
  const executeUnavailable = await runDelegate({
    args: {
      positional: ["fix"],
      flags: { write: true, isolated: true, "allow-exec": true },
    },
    deps: quietDeps({ resolveWorkspaceRoot: neverResolveWorkspace }),
  });

  assert.equal(isolatedWithoutWrite.exitCode, 2);
  assert.equal(isolatedWithoutWrite.stderr, "--isolated requires --write\n");
  assert.equal(executeWithoutIsolation.exitCode, 2);
  assert.match(executeWithoutIsolation.stderr, /^AUTHORITY_INVALID:/u);
  assert.match(executeWithoutIsolation.stderr, /--write --isolated/u);
  assert.equal(executeUnavailable.exitCode, 2);
  assert.match(executeUnavailable.stderr, /^AUTHORITY_EXECUTE_UNAVAILABLE:/u);
  assert.match(executeUnavailable.stderr, /Remove --allow-exec/u);
});

test("delegate validates fetch confinement and emits a structured authority error", async () => {
  const result = await runDelegate({
    args: {
      positional: ["research"],
      flags: { "allow-fetch": true, sandbox: "inherit", json: true },
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.schemaVersion, 1);
  assert.equal(diagnostic.error.code, "AUTHORITY_INVALID");
  assert.equal(diagnostic.error.reason, "fetch-requires-confined");
});

test("delegate pins one bounded diff into the actual prompt while keeping the record concise", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  let diffCalls = 0;
  let diffArgs: unknown;

  const resultPromise = runDelegate({
    args: {
      positional: ["review", "the", "change"],
      flags: { "include-diff": true, base: "origin/main" },
    },
    env: { CONSULT_HOST: "codex", CONSULT_HOST_SESSION_ID: "codex-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      getDiff: async (args: unknown) => {
        diffCalls += 1;
        diffArgs = args;
        return "diff --git a/a.ts b/a.ts\n+changed();\n";
      },
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-pinned-diff",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-pinned-diff",
    stopReason: "end_turn",
    sessionId: "session-pinned-diff",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-pinned-diff.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(diffCalls, 1);
  assert.deepEqual(diffArgs, { baseRef: "origin/main", cwd: workspaceRoot });
  assert.match(request.params.prompt as string, /^review the change\n\n--- BEGIN CONSULT/);
  assert.match(request.params.prompt as string, /Snapshot: base "origin\/main"/);
  assert.match(request.params.prompt as string, /\+changed\(\);/);
  assert.match(request.params.prompt as string, /--- END CONSULT PINNED GIT DIFF ---$/);
  assert.equal(record.prompt, "review the change");
  assert.equal(record.includeDiff, true);
  assert.equal(record.baseRef, "origin/main");
});

test("delegate include-diff captures the working tree when no base is supplied", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  let diffArgs: unknown;

  const resultPromise = runDelegate({
    args: { positional: ["inspect"], flags: { "include-diff": true } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      getDiff: async (args: unknown) => {
        diffArgs = args;
        return "";
      },
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-working-diff",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-working-diff",
    stopReason: "end_turn",
    sessionId: "session-working-diff",
  });
  await resultPromise;

  assert.deepEqual(diffArgs, { cwd: workspaceRoot });
  assert.match(request.params.prompt as string, /Snapshot: working tree/);
  assert.match(request.params.prompt as string, /\(no changes\)/);
});

test("delegate reports pinned diff errors before creating a Job", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  let generated = false;
  let recordWritten = false;

  const result = await runDelegate({
    args: {
      positional: ["inspect"],
      flags: { "include-diff": true, base: "missing" },
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      getDiff: async () => {
        throw new Error("base ref 'missing' does not resolve to a commit");
      },
      generateJobId: () => {
        generated = true;
        return "should-not-exist";
      },
      writeJobRecord: async () => {
        recordWritten = true;
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unable to capture pinned git diff/);
  assert.equal(generated, true);
  assert.equal(recordWritten, false);
});

test("delegate fails authority preflight before diff, isolation, or Job persistence", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  let diffCalled = false;
  let isolationCalled = false;
  let recordWritten = false;
  const result = await runDelegate({
    args: {
      positional: ["inspect"],
      flags: { write: true, isolated: true, "include-diff": true, json: true },
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      generateJobId: () => "job-preflight-failed",
      preflightAuthority: async (input: { profile: string; profileRegistryId?: string }) => {
        assert.equal(input.profile, "codex");
        assert.equal(input.profileRegistryId, "codex");
        return {
          ok: false as const,
          diagnostic: {
            code: "AUTHORITY_PREFLIGHT_FAILED" as const,
            message: "nested confinement unavailable",
            remediation: "Retry with --sandbox inherit if ambient authority is acceptable.",
          },
        };
      },
      getDiff: async () => {
        diffCalled = true;
        return "diff";
      },
      prepareIsolatedWorkspace: async () => {
        isolationCalled = true;
        throw new Error("should not run");
      },
      writeJobRecord: async () => {
        recordWritten = true;
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "AUTHORITY_PREFLIGHT_FAILED");
  assert.equal(diffCalled, false);
  assert.equal(isolationCalled, false);
  assert.equal(recordWritten, false);
});

test("delegate rejects --base without --include-diff", async () => {
  const result = await runDelegate({
    args: { positional: ["inspect"], flags: { base: "main" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--base requires --include-diff\n");
});

test("delegate resume uses the latest finalized session for the selected profile", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-old.json"),
    JSON.stringify({
      jobId: "job-old",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "codex",
      completedAt: "2026-05-14T09:00:00.000Z",
      sessionId: "session-old",
    }),
  );
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-new.json"),
    JSON.stringify({
      jobId: "job-new",
      status: "failed",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "codex",
      completedAt: "2026-05-14T09:30:00.000Z",
      sessionId: "session-new",
    }),
  );
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-other.json"),
    JSON.stringify({
      jobId: "job-other",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "claude",
      completedAt: "2026-05-14T10:30:00.000Z",
      sessionId: "session-other",
    }),
  );
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["continue"], flags: { resume: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: fixedClock(["2026-05-14T11:00:00.000Z"]),
      generateJobId: () => "job-resume",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-resume",
    stopReason: "end_turn",
    sessionId: "session-finished",
  });
  await resultPromise;

  assert.equal(request.params.resume, "session-new");
  assert.equal(request.params.resumeJobId, "job-new");
});

test("delegate resume ignores newer jobs from other Host sessions", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-current-chat.json"),
    JSON.stringify({
      jobId: "job-current-chat",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "codex",
      completedAt: "2026-05-14T09:00:00.000Z",
      sessionId: "session-current-chat",
    }),
  );
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-other-chat.json"),
    JSON.stringify({
      jobId: "job-other-chat",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-2",
      profile: "codex",
      completedAt: "2026-05-14T10:00:00.000Z",
      sessionId: "session-other-chat",
    }),
  );
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["continue"], flags: { resume: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: fixedClock(["2026-05-14T11:00:00.000Z"]),
      generateJobId: () => "job-resume",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-resume",
    stopReason: "end_turn",
    sessionId: "session-finished",
  });
  await resultPromise;

  assert.equal(request.params.resume, "session-current-chat");
});

test("delegate resume-job resumes an explicit job across Host sessions", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-other-chat.json"),
    JSON.stringify({
      jobId: "job-other-chat",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-2",
      profile: "codex",
      completedAt: "2026-05-14T10:00:00.000Z",
      sessionId: "session-other-chat",
    }),
  );
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["continue"], flags: { "resume-job": "job-other-chat" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      now: fixedClock(["2026-05-14T11:00:00.000Z"]),
      generateJobId: () => "job-resume-explicit",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-resume-explicit",
    stopReason: "end_turn",
    sessionId: "session-finished",
  });
  await resultPromise;

  assert.equal(request.params.resume, "session-other-chat");
  assert.equal(request.params.resumeJobId, "job-other-chat");
});

test("confined resume rejects an unavailable archive before creating a Job", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-source.json"),
    JSON.stringify({
      jobId: "job-source",
      status: "completed",
      profile: "codex",
      completedAt: "2026-05-14T10:00:00.000Z",
      sessionId: "session-source",
    }),
  );

  const result = await runDelegate({
    args: { positional: ["continue"], flags: { "resume-job": "job-source" } },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      generateJobId: () => "job-must-not-exist",
      validateSessionStateArchive: async () => {
        throw new Error("archive missing");
      },
      ensureBrokerSession: async () => {
        throw new Error("Broker should not start");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /RESUME_STATE_UNAVAILABLE.*archive missing/u);
  await assert.rejects(
    fs.access(path.join(jobsDir(workspaceRoot), "job-must-not-exist.json")),
  );
});

test("delegate resume-job rejects jobs from another profile", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-claude.json"),
    JSON.stringify({
      jobId: "job-claude",
      status: "completed",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "claude",
      completedAt: "2026-05-14T10:00:00.000Z",
      sessionId: "session-claude",
    }),
  );

  const result = await runDelegate({
    args: { positional: ["continue"], flags: { "resume-job": "job-claude" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /belongs to profile 'claude'/);
});

test("delegate reports setup guidance when no profiles are configured", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDelegate({
    args: { positional: ["fix"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => ({ schemaVersion: 1, default: null, profiles: {} }),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /\(no profiles configured; run 'consult setup'\)/);
});

test("delegate exits 2 when profiles are malformed", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDelegate({
    args: { positional: ["fix"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => {
        const error = new Error("Profiles file is malformed") as NodeJS.ErrnoException & {
          path?: string;
        };
        error.code = "PROFILES_MALFORMED";
        error.path = "/tmp/profiles.json";
        throw error;
      },
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "profiles malformed: /tmp/profiles.json\n");
});

test("delegate exits 2 when the workspace override is malformed", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDelegate({
    args: { positional: ["fix"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadProfiles: async () => profilesFixture(),
      loadOverride: async () => {
        const error = new Error("Workspace override file is malformed") as NodeJS.ErrnoException & {
          path?: string;
        };
        error.code = "WORKSPACE_OVERRIDE_MALFORMED";
        error.path = "/tmp/override.json";
        throw error;
      },
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "workspace override malformed: /tmp/override.json\n");
});

test("delegate rejects mutually exclusive write and read-only flags", async () => {
  const result = await runDelegate({
    args: { positional: ["fix"], flags: { write: true, "read-only": true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--write and --read-only are mutually exclusive/);
});

test("delegate rejects mutually exclusive background and wait flags", async () => {
  const result = await runDelegate({
    args: { positional: ["fix"], flags: { background: true, wait: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--background and --wait are mutually exclusive/);
});

test("delegate background writes a queued record and spawns the task worker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const spawns: { command: string; argv: string[]; options: unknown }[] = [];
  let unrefCalled = false;

  const result = await runDelegate({
    args: { positional: ["fix", "later"], flags: { background: true, agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched by background spawner");
      },
      generateJobId: () => "job-bg",
      now: () => "2026-05-14T10:00:00.000Z",
      spawn: (command: string, argv: string[], options: unknown) => {
        spawns.push({ command, argv, options });
        return {
          unref() {
            unrefCalled = true;
          },
        };
      },
    }),
  });

  const record = JSON.parse(
    (await fs.readFile(path.join(jobsDir(workspaceRoot), "job-bg.json"))) as unknown as string,
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /job-bg/);
  assert.match(result.stdout, /consult status job-bg/);
  assert.doesNotMatch(result.stdout, /\/consult:status/);
  assert.equal(record.status, "queued");
  assert.equal(record.prompt, "fix later");
  assert.equal(record.mode, "read-only");
  assert.equal(record.host, "claude-code");
  assert.equal(record.profile, "codex");
  assert.equal(record.hostSessionId, "claude-1");
  assert.equal(record.chainId, "job-bg");
  assert.equal(record.parentJobId, null);
  assert.equal(record.delegationDepth, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.deepEqual(spawns[0].argv.slice(-3), ["task-worker", "--job-id", "job-bg"]);
  assert.equal((spawns[0].options as { detached: boolean }).detached, true);
  assert.equal((spawns[0].options as { stdio: string }).stdio, "ignore");
  assert.equal((spawns[0].options as { cwd: string }).cwd, workspaceRoot);
  assert.equal(unrefCalled, true);
});

test("delegate background persists its prepared isolated workspace for the inline worker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const prepared = isolatedFixture(workspaceRoot, "job-bg-isolated");
  let spawned = false;

  const result = await runDelegate({
    args: {
      positional: ["fix", "later"],
      flags: { background: true, write: true, isolated: true },
    },
    env: { CONSULT_HOST: "terminal", CONSULT_HOST_SESSION_ID: "terminal-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      generateJobId: () => "job-bg-isolated",
      prepareIsolatedWorkspace: async () => prepared,
      spawn: () => {
        spawned = true;
        return { unref() {} } as never;
      },
    }),
  });

  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-bg-isolated.json"), "utf8"),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(spawned, true);
  assert.equal(record.status, "queued");
  assert.equal(record.isolated, true);
  assert.equal(record.isolatedWorkspace.executionRoot, prepared.executionRoot);
  assert.equal(record.cleanupMetadataPath, prepared.cleanupMetadataPath);
});

test("delegate cleans a prepared isolated workspace when the background worker cannot spawn", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const prepared = isolatedFixture(workspaceRoot, "job-bg-spawn-failure");
  let cleanupCalls = 0;

  const result = await runDelegate({
    args: {
      positional: ["fix", "later"],
      flags: { background: true, write: true, isolated: true },
    },
    env: { CONSULT_HOST: "terminal", CONSULT_HOST_SESSION_ID: "terminal-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      generateJobId: () => "job-bg-spawn-failure",
      prepareIsolatedWorkspace: async () => prepared,
      cleanupIsolatedWorkspace: async () => {
        cleanupCalls += 1;
        return {};
      },
      spawn: () => {
        throw new Error("no process slots");
      },
    }),
  });

  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-bg-spawn-failure.json"), "utf8"),
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /task worker spawn failed: no process slots/);
  assert.equal(cleanupCalls, 1);
  assert.equal(record.status, "failed");
});

test("delegate background persists the augmented pinned prompt for the task worker", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDelegate({
    args: {
      positional: ["review", "later"],
      flags: { background: true, "include-diff": true },
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      getDiff: async () => "diff --git a/a b/a\n+queued change\n",
      generateJobId: () => "job-bg-pinned",
      spawn: () => ({ unref() {} }),
    }),
  });

  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-bg-pinned.json"), "utf8"),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(record.includeDiff, true);
  assert.match(record.prompt, /^review later\n\n--- BEGIN CONSULT/);
  assert.match(record.prompt, /\+queued change/);
});

test("delegate background json mode emits one queued JSON object", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDelegate({
    args: { positional: ["fix", "later"], flags: { background: true, json: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be touched by background spawner");
      },
      generateJobId: () => "job-bg-json",
      spawn: () => ({ unref() {} }),
    }),
  });

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.job.id, "job-bg-json");
  assert.equal(envelope.job.status, "queued");
  assert.equal(envelope.outcome.sessionId, null);
  assert.equal(envelope.artifacts.logPath, path.join(logsDir(workspaceRoot), "job-bg-json.log"));
});

test("delegate exits 2 when --agent is passed without a value", async () => {
  const result = await runDelegate({
    args: { positional: ["fix"], flags: { agent: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => {
        throw new Error("workspace should not be resolved");
      },
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--agent requires a value\n");
});

test("delegate honors --no-write as read-only", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["look", "around"], flags: { write: false } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-no-write",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-no-write",
    stopReason: "end_turn",
    sessionId: "session-no-write",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-no-write.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.mode, "read-only");
  assert.equal(request.params.mode, "read-only");
});

test("delegate exits 6 when the turn finalizes as failed", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["doomed"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-fail-exit",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-fail-exit",
    stopReason: "failed",
    sessionId: "session-fail",
    errorMessage: "delegate blew up",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-fail-exit.json"), "utf8"),
  );

  assert.equal(result.exitCode, 6);
  assert.match(result.stdout, /consult delegate job-fail-exit failed/);
  assert.equal(record.status, "failed");
});

test("delegate defaults the parent job from CONSULT_PARENT_JOB when the flag is absent", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeParentJob(workspaceRoot, {
    jobId: "job-env-parent",
    chainId: "job-env-parent",
    delegationDepth: 0,
    mode: "write",
  });
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["child", "prompt"], flags: {} },
    env: {
      CONSULT_HOST: "claude-code",
      CONSULT_HOST_SESSION_ID: "claude-1",
      CONSULT_PARENT_JOB: "job-env-parent",
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-env-child",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-env-child",
    stopReason: "end_turn",
    sessionId: "session-env-child",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-env-child.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.parentJobId, "job-env-parent");
  assert.equal(record.chainId, "job-env-parent");
  assert.equal(record.delegationDepth, 1);
});

test("delegate prefers an explicit --parent-job flag over CONSULT_PARENT_JOB", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeParentJob(workspaceRoot, {
    jobId: "job-env-parent",
    chainId: "job-env-parent",
    delegationDepth: 0,
    mode: "write",
  });
  await writeParentJob(workspaceRoot, {
    jobId: "job-flag-parent",
    chainId: "job-flag-parent",
    delegationDepth: 0,
    mode: "write",
  });
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["child", "prompt"], flags: { "parent-job": "job-flag-parent" } },
    env: {
      CONSULT_HOST: "claude-code",
      CONSULT_HOST_SESSION_ID: "claude-1",
      CONSULT_PARENT_JOB: "job-env-parent",
    },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-flag-child",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-flag-child",
    stopReason: "end_turn",
    sessionId: "session-flag-child",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-flag-child.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.parentJobId, "job-flag-parent");
  assert.equal(record.chainId, "job-flag-parent");
});

test("delegate truncates stored prompts on a UTF-8 boundary", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  const prompt = `${"a".repeat(4095)}€ after`;

  const resultPromise = runDelegate({
    args: { positional: [], flags: { prompt } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-utf8",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-utf8",
    stopReason: "end_turn",
    sessionId: "session-utf8",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-utf8.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.prompt, `${"a".repeat(4095)}...`);
  assert.equal(record.prompt.includes("\uFFFD"), false);
});

test("delegate child job inherits lineage and read-only permission ceiling from parent", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), "job-parent.json"),
    JSON.stringify({
      jobId: "job-parent",
      kind: "delegate",
      status: "completed",
      submittedAt: "2026-05-14T09:00:00.000Z",
      chainId: "job-root",
      parentJobId: "job-root",
      delegationDepth: 1,
      mode: "read-only",
      host: "claude-code",
      profile: "codex",
      prompt: "parent prompt",
      hostSessionId: "claude-1",
    }),
  );
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["child", "prompt"], flags: { "parent-job": "job-parent" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-child",
    }),
  });

  const request = await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-child",
    stopReason: "end_turn",
    sessionId: "session-child",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-child.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(record.chainId, "job-root");
  assert.equal(record.parentJobId, "job-parent");
  assert.equal(record.delegationDepth, 2);
  assert.equal(record.mode, "read-only");
  assert.equal(request.params.chainId, "job-root");
  assert.equal(request.params.parentJobId, "job-parent");
  assert.equal(request.params.delegationDepth, 2);
  assert.equal(request.params.mode, "read-only");
});

test("delegate child job rejects explicit write under read-only parent", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeParentJob(workspaceRoot, {
    jobId: "job-parent",
    chainId: "job-parent",
    delegationDepth: 0,
    mode: "read-only",
  });

  const result = await runDelegate({
    args: {
      positional: ["child", "prompt"],
      flags: { "parent-job": "job-parent", write: true },
    },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
      generateJobId: () => "job-child",
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /cannot use --write when parent job is read-only/);
});

test("delegate child job rejects depth beyond the delegation cap", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeParentJob(workspaceRoot, {
    jobId: "job-parent",
    chainId: "job-root",
    delegationDepth: 2,
    mode: "write",
  });

  const result = await runDelegate({
    args: { positional: ["child", "prompt"], flags: { "parent-job": "job-parent" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
      generateJobId: () => "job-child",
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /delegation depth 3 exceeds max 2/);
});

test("delegate child job exits 2 for a malformed parent job record", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const recordPath = await writeMalformedJob(workspaceRoot, "job-parent");

  const result = await runDelegate({
    args: { positional: ["child", "prompt"], flags: { "parent-job": "job-parent" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        throw new Error("broker should not be started");
      },
      generateJobId: () => "job-child",
    }),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `job record malformed: ${recordPath}\n`);
});

test("delegate surfaces broker busy as exit code 3", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  client.rejectRequest(
    Object.assign(new Error("broker already has an in-flight prompt turn"), {
      code: "BROKER_BUSY",
    }),
  );

  const result = await runDelegate({
    args: { positional: ["fix"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-busy",
    }),
  });

  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /BROKER_BUSY/);
  assert.match(result.stderr, /in-flight prompt turn/);
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-busy.json"), "utf8"),
  );
  assert.equal(record.status, "failed");
  assert.match(record.errorMessage, /BROKER_BUSY/);
});

test("delegate defaults direct CLI use to terminal/default host identity", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();
  let ensureArgs: { host?: string; hostSessionId?: string } | undefined;

  const resultPromise = runDelegate({
    args: { positional: ["fix"], flags: {} },
    env: {},
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async (args: { host?: string; hostSessionId?: string }) => {
        ensureArgs = args;
        return { client };
      },
      generateJobId: () => "job-terminal",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/finalized", {
    jobId: "job-terminal",
    stopReason: "end_turn",
    sessionId: "session-terminal",
  });
  const result = await resultPromise;
  const record = JSON.parse(
    await fs.readFile(path.join(jobsDir(workspaceRoot), "job-terminal.json"), "utf8"),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(ensureArgs?.host, "terminal");
  assert.equal(ensureArgs?.hostSessionId, "default");
  assert.equal(record.host, "terminal");
  assert.equal(record.hostSessionId, "default");
});

test("delegate writes update and finalized notifications to the NDJSON log", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["log", "this"], flags: {} },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-log",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("one", "job-log"));
  client.notify("consult/update", agentTextUpdate("two", "job-log"));
  client.notify("consult/finalized", {
    jobId: "job-log",
    stopReason: "end_turn",
    sessionId: "session-log",
  });
  await resultPromise;

  const lines = (await fs.readFile(path.join(logsDir(workspaceRoot), "job-log.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].method, "consult/update");
  assert.equal(lines[1].method, "consult/update");
  assert.equal(lines[2].method, "consult/finalized");
});

test("delegate json mode emits one versioned final job result object", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  const client = new FakeBrokerClient();

  const resultPromise = runDelegate({
    args: { positional: ["summarize"], flags: { json: true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => workspaceRoot,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => ({ client }),
      generateJobId: () => "job-json",
    }),
  });

  await client.waitForRequest("consult/run");
  client.notify("consult/update", agentTextUpdate("json text", "job-json"));
  client.notify("consult/finalized", {
    jobId: "job-json",
    stopReason: "end_turn",
    sessionId: "session-json",
    touchedFiles: ["src/fixed.mts"],
  });
  const result = await resultPromise;

  assert.equal(result.stdout.trim().split("\n").length, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.job.status, "completed");
  assert.equal(summary.job.id, "job-json");
  assert.equal(summary.outcome.sessionId, "session-json");
  assert.equal(summary.outcome.stopReason, "end_turn");
  assert.equal(summary.outcome.finalText, "json text");
  assert.deepEqual(summary.artifacts.touchedFiles, ["src/fixed.mts"]);
  assert.equal(summary.artifacts.logPath, path.join(logsDir(workspaceRoot), "job-json.log"));
});

interface BrokerRequest {
  method: string;
  params: Record<string, unknown>;
}

class FakeBrokerClient {
  #handlers = new Map<string, (params: Record<string, unknown>) => void>();
  #requests = new Map<string, BrokerRequest>();
  #requestResolvers = new Map<string, (request: BrokerRequest) => void>();
  #requestError: Error | null = null;

  on(method: string, handler: (params: Record<string, unknown>) => void) {
    this.#handlers.set(method, handler);
  }

  async request(method: string, params: Record<string, unknown>) {
    this.#requests.set(method, { method, params });
    this.#requestResolvers.get(method)?.({ method, params });
    if (this.#requestError) {
      throw this.#requestError;
    }
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

  rejectRequest(error: Error) {
    this.#requestError = error;
  }
}

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-delegate-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

async function writeParentJob(workspaceRoot: string, fields: Record<string, unknown>) {
  await fs.mkdir(jobsDir(workspaceRoot), { recursive: true });
  await fs.writeFile(
    path.join(jobsDir(workspaceRoot), `${fields.jobId}.json`),
    JSON.stringify({
      kind: "delegate",
      status: "completed",
      submittedAt: "2026-05-14T09:00:00.000Z",
      parentJobId: null,
      host: "claude-code",
      profile: "codex",
      prompt: "parent prompt",
      hostSessionId: "claude-1",
      ...fields,
    }),
  );
}

async function writeMalformedJob(workspaceRoot: string, jobId: string) {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, "{", "utf8");
  return recordPath;
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

function quietDeps(deps: Record<string, unknown>): DelegateDeps {
  return {
    preflightAuthority: async (input: { authority: JobAuthority }) => ({
      ok: true as const,
      authority: input.authority,
    }),
    validateSessionStateArchive: async () => {},
    ...deps,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  } as DelegateDeps;
}

function profilesFixture() {
  return {
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/bin/codex-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T09:00:00.000Z",
      },
    },
  };
}

function fixedClock(values: string[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function agentTextUpdate(text: string, jobId = "job-happy") {
  return {
    jobId,
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function isolatedFixture(workspaceRoot: string, jobId: string): PreparedIsolatedWorkspace {
  const transactionRoot = path.join(path.dirname(workspaceRoot), "data", "isolated-jobs", jobId);
  const artifactsDir = path.join(transactionRoot, "artifacts");
  return {
    schemaVersion: 1,
    jobId,
    workspaceRoot,
    executionRoot: path.join(transactionRoot, "worktree"),
    transactionRoot,
    artifactsDir,
    cleanupMetadataPath: path.join(artifactsDir, "cleanup.json"),
    headCommit: "a".repeat(40),
    baselineTree: "b".repeat(40),
    preparedAt: "2026-07-09T10:00:00.000Z",
    maxBufferBytes: 1024,
    seeded: {
      stagedPatchBytes: 0,
      unstagedPatchBytes: 0,
      untrackedFiles: [],
    },
  };
}

function finalizedIsolation(
  prepared: PreparedIsolatedWorkspace,
): FinalizedIsolatedWorkspace {
  return {
    schemaVersion: 1,
    jobId: prepared.jobId,
    workspaceRoot: prepared.workspaceRoot,
    executionRoot: prepared.executionRoot,
    baselineTree: prepared.baselineTree,
    patchPath: `${prepared.artifactsDir}/changes.patch`,
    patchBytes: 123,
    touchedFilesPath: `${prepared.artifactsDir}/touched-files.json`,
    touchedFiles: ["src/changed.mts"],
    cleanupMetadataPath: prepared.cleanupMetadataPath,
    finalizedAt: "2026-07-09T10:01:00.000Z",
  };
}
