import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { profilesPath } from "../broker-endpoint.mjs";
import { runSetup } from "./setup.mjs";

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
  assert.equal(payload.registry.length, 4);
  assert.deepEqual(payload.profiles, {
    schemaVersion: 1,
    default: null,
    hostDefaults: {},
    profiles: {},
  });
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
        stage: "install",
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
        const error = new Error("Registry file is malformed: /tmp/registry.json");
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
        const error = new Error("Registry schema mismatch");
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

function withDataDir(t, dataDir) {
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

async function writeProfiles(profiles) {
  await fs.mkdir(path.dirname(profilesPath()), { recursive: true });
  await fs.writeFile(profilesPath(), JSON.stringify(profiles));
}

function profileFixture(overrides = {}) {
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
