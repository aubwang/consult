import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "./review.mjs";

test("review with codex profile calls the codex adapter", async () => {
  let adapterArgs;
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("codex"),
      runCodexReview: async (args) => {
        adapterArgs = args;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(adapterArgs.profile, "codex");
  assert.equal(adapterArgs.workspaceRoot, "/workspace");
  assert.equal(adapterArgs.host, "claude-code");
  assert.equal(adapterArgs.hostSessionId, "claude-1");
  assert.equal(adapterArgs.kind, "review");
});

for (const profile of ["claude", "opencode", "copilot"]) {
  test(`review with ${profile} profile exits with the codex-only message`, async () => {
    const result = await runReview({
      args: { positional: [], flags: { agent: profile } },
      env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
      deps: quietDeps({
        resolveWorkspaceRoot: async () => "/workspace",
        loadOverride: async () => null,
        loadProfiles: async () => profilesFixture(profile),
        runCodexReview: async () => {
          throw new Error("adapter should not run");
        },
      }),
    });

    assert.equal(result.exitCode, 6);
    assert.equal(
      result.stderr,
      "/consult:review is codex-only in v1. Use /consult:delegate --agent <name> with a review-style prompt, or switch to --agent codex.\n",
    );
  });
}

test("review exits 2 when profiles are malformed", async () => {
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadProfiles: async () => {
        const error = new Error("Profiles file is malformed");
        error.code = "PROFILES_MALFORMED";
        error.path = "/tmp/profiles.json";
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
        const error = new Error("Workspace override file is malformed");
        error.code = "WORKSPACE_OVERRIDE_MALFORMED";
        error.path = "/tmp/override.json";
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

function quietDeps(deps) {
  return {
    ...deps,
    stdoutWrite: () => {},
    stderrWrite: () => {},
  };
}

function profilesFixture(defaultProfile) {
  return {
    schemaVersion: 1,
    default: defaultProfile,
    profiles: {
      codex: profileEntry("codex"),
      claude: profileEntry("claude"),
      opencode: profileEntry("opencode"),
      copilot: profileEntry("copilot"),
    },
  };
}

function profileEntry(registryId) {
  return {
    registryId,
    binary: `/bin/${registryId}`,
    args: [],
    env: {},
    installedAt: "2026-05-14T09:00:00.000Z",
  };
}
