import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { profilesPath } from "../broker-endpoint.mts";
import { runSetup } from "./setup.mts";

test("setup json mode prints registry status and profiles", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const result = await runSetup({
    args: { positional: [], flags: { json: true } },
    deps: { whichBinary: async () => null },
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(
    payload.registry.map((entry: { id: string }) => entry.id),
    ["codex", "claude", "opencode"],
  );
  assert.deepEqual(payload.profiles, {
    schemaVersion: 1,
    default: null,
    hostDefaults: {},
    profiles: {},
  });
});

test("setup exits 2 when --install or --set-default is passed without a value", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const installResult = await runSetup({
    args: { positional: [], flags: { install: true } },
    deps: {},
  });
  assert.equal(installResult.exitCode, 2);
  assert.equal(installResult.stderr, "--install requires a value\n");

  const setDefaultResult = await runSetup({
    args: { positional: [], flags: { "set-default": true } },
    deps: {},
  });
  assert.equal(setDefaultResult.exitCode, 2);
  assert.equal(setDefaultResult.stderr, "--set-default requires a value\n");
});

test("setup install persists a verified profile", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const result = await runSetup({
    args: { positional: [], flags: { install: "codex" } },
    deps: {
      installAndVerify: async ({ registryEntry }) => ({
        ok: true,
        profile: {
          registryId: registryEntry.id,
          binary: "/fake/codex-acp",
          args: [],
          env: {},
          installedAt: "2026-05-15T10:00:00.000Z",
          installedVia: "registry",
          lastVerifiedAt: "2026-05-15T10:00:01.000Z",
        },
      }),
    },
  });

  const profiles = JSON.parse(await fs.readFile(profilesPath(), "utf8"));
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /verified codex/);
  assert.equal(profiles.profiles.codex.binary, "/fake/codex-acp");
});

test("setup install failure prints captured stderr and does not persist", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const result = await runSetup({
    args: { positional: [], flags: { install: "codex" } },
    deps: {
      installAndVerify: async () => ({
        ok: false,
        stage: "install" as const,
        message: "install command exited 1",
        captured: { stdout: "", stderr: "npm failed", exitCode: 1 },
      }),
    },
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /npm failed/);
  await assert.rejects(fs.readFile(profilesPath(), "utf8"), { code: "ENOENT" });
});

test("setup exits 2 when the registry is malformed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const result = await runSetup({
    args: { positional: [], flags: { json: true } },
    deps: {
      loadRegistry: async () => {
        const error = new Error("Registry file is malformed: /tmp/registry.json") as Error & {
          code: string;
          path: string;
        };
        error.code = "REGISTRY_MALFORMED";
        error.path = "/tmp/registry.json";
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "registry malformed: /tmp/registry.json\n");
});

test("setup exits 2 when the registry schema mismatches", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);

  const result = await runSetup({
    args: { positional: [], flags: { json: true } },
    deps: {
      loadRegistry: async () => {
        const error = new Error("Registry schema mismatch") as Error & {
          code: string;
          path: string;
        };
        error.code = "REGISTRY_SCHEMA_MISMATCH";
        error.path = "/tmp/registry.json";
        throw error;
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "registry schema mismatch: /tmp/registry.json\n");
});

test("setup exits 2 when profiles are malformed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "missing",
    profiles: {},
  });

  const result = await runSetup({
    args: { positional: [], flags: { json: true } },
    deps: {},
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `profiles malformed: ${profilesPath()}\n`);
});

test("setup set-default updates profiles default", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-setup-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: null,
    profiles: {
      codex: profileFixture(),
    },
  });

  const result = await runSetup({
    args: { positional: [], flags: { "set-default": "codex" } },
    deps: {},
  });

  const profiles = JSON.parse(await fs.readFile(profilesPath(), "utf8"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "default set to codex\n");
  assert.equal(profiles.default, "codex");
});

function withDataDir(t: { after: (fn: () => void) => void }, dataDir: string): void {
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

async function writeProfiles(profiles: object): Promise<void> {
  await fs.mkdir(path.dirname(profilesPath()), { recursive: true });
  await fs.writeFile(profilesPath(), JSON.stringify(profiles));
}

function profileFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registryId: "codex",
    binary: "/fake/codex-acp",
    args: [],
    env: {},
    installedAt: "2026-05-15T10:00:00.000Z",
    installedVia: "registry",
    ...overrides,
  };
}
