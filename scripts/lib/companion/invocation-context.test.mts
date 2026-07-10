import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { overrideFilePath } from "../broker-endpoint.mts";
import {
  loadWorkspaceOverride,
  resolveInvocationContext,
  selectProfile,
} from "./invocation-context.mts";

test("selectProfile preserves explicit, workspace, host, global precedence", () => {
  const profiles = {
    default: "global",
    hostDefaults: { codex: "host" },
    profiles: {
      explicit: {},
      workspace: {},
      host: {},
      global: {},
    },
  };

  assert.equal(
    selectProfile({
      args: { flags: { agent: "explicit" } },
      profiles: profiles as never,
      override: { profile: "workspace" },
      host: "codex",
    }).profile,
    "explicit",
  );
  assert.equal(
    selectProfile({
      args: { flags: {} },
      profiles: profiles as never,
      override: { profile: "workspace" },
      host: "codex",
    }).profile,
    "workspace",
  );
  assert.equal(
    selectProfile({
      args: { flags: {} },
      profiles: profiles as never,
      override: null,
      host: "codex",
    }).profile,
    "host",
  );
  assert.equal(
    selectProfile({
      args: { flags: {} },
      profiles: profiles as never,
      override: null,
      host: "unknown",
    }).profile,
    "global",
  );
});

test("selectProfile preserves error wording", () => {
  assert.equal(
    selectProfile({
      args: { flags: {} },
      profiles: { default: null, profiles: {} } as never,
      override: null,
      host: "codex",
    }).error,
    "No profile configured (no profiles configured; run 'consult setup')",
  );
  assert.equal(
    selectProfile({
      args: { flags: { profile: "missing" } },
      profiles: { default: "codex", profiles: { codex: {} } } as never,
      override: null,
      host: "codex",
    }).error,
    "Unknown profile 'missing'. Available profiles: codex",
  );
});

test("resolveInvocationContext returns workspace, host identity, profiles, override, and selection", async () => {
  const context = await resolveInvocationContext({
    args: { positional: [], flags: {} },
    env: { CONSULT_HOST: "codex", CONSULT_HOST_SESSION_ID: "thread-1" },
    deps: {
      resolveWorkspaceRoot: async () => "/workspace",
      loadProfiles: async () => ({
        schemaVersion: 1,
        default: "global",
        hostDefaults: { codex: "host" },
        profiles: { host: { registryId: "codex" }, global: {} } as never,
      }),
      loadOverride: async () => null,
    },
  });

  assert.equal(context.workspaceRoot, "/workspace");
  assert.deepEqual(context.hostIdentity, { host: "codex", hostSessionId: "thread-1" });
  assert.equal(context.selected.profile, "host");
  assert.deepEqual(context.selected.profileEntry, { registryId: "codex" });
});

test("resolveInvocationContext preserves delegated original Workspace identity from the environment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-original-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const context = await resolveInvocationContext({
    args: { positional: [], flags: {} },
    env: { CONSULT_WORKSPACE: root, CONSULT_HOST: "terminal" },
    deps: {
      loadProfiles: async () => ({
        schemaVersion: 1,
        default: "codex",
        profiles: { codex: {} as never },
      }),
      loadOverride: async () => null,
    },
  });

  assert.equal(context.workspaceRoot, await fs.realpath(root));
});

test("loadWorkspaceOverride rejects malformed JSON with a named error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-override-"));
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(root, "data");
  t.after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const overridePath = overrideFilePath(root);
  await fs.mkdir(path.dirname(overridePath), { recursive: true });
  await fs.writeFile(overridePath, "{", "utf8");

  await assert.rejects(loadWorkspaceOverride(root), (error) => {
    assert.equal((error as NodeJS.ErrnoException).code, "WORKSPACE_OVERRIDE_MALFORMED");
    assert.equal((error as Error).message, "Workspace override file is malformed");
    assert.equal((error as NodeJS.ErrnoException & { path: string }).path, overridePath);
    return true;
  });
});
