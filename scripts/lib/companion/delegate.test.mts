import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { jobsDir, logsDir } from "../broker-endpoint.mts";
import { runDelegate } from "./delegate.mts";
import type { DelegateDeps } from "./delegate.mts";

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
  assert.equal(record.chainId, "job-happy");
  assert.equal(record.parentJobId, null);
  assert.equal(record.delegationDepth, 0);
  assert.equal(record.finalText, "hello world");
  assert.equal(request.params.mode, "read-only");
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
  assert.equal(request.params.mode, "write");
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
  assert.deepEqual(JSON.parse(result.stdout), { status: "queued", jobId: "job-bg-json" });
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

test("delegate json mode emits one final job summary object", async (t) => {
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
  });
  const result = await resultPromise;

  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(summary.status, "completed");
  assert.equal(summary.jobId, "job-json");
  assert.equal(summary.sessionId, "session-json");
  assert.equal(summary.stopReason, "end_turn");
  assert.equal(summary.finalTextLength, "json text".length);
  assert.equal(summary.logPath, path.join(logsDir(workspaceRoot), "job-json.log"));
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
