import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "./review.mts";
import type { ReviewDeps } from "./review.mts";
import type { ProfileRecord } from "../profiles.mts";

test("review with codex profile calls the codex adapter", async () => {
  let adapterArgs: Record<string, unknown> | undefined;
  const result = await runReview({
    args: { positional: [], flags: { agent: "codex" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("codex"),
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

    assert.equal(result.exitCode, 7);
    assert.equal(
      result.stderr,
      "/consult:review is codex-only in v1. Use /consult:delegate --agent <name> with a review-style prompt, or switch to --agent codex.\n",
    );
  });
}

test("review reads advertisesReview from the registry instead of hardcoding codex", async () => {
  let adapterRan = false;
  const result = await runReview({
    args: { positional: [], flags: { agent: "claude" } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: quietDeps({
      resolveWorkspaceRoot: async () => "/workspace",
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture("claude"),
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
      copilot: profileEntry("copilot"),
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
