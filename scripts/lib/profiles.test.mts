import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { ProfilesError } from "./profiles.mts";
import {
  loadProfiles,
  saveProfiles,
  setDefaultProfile,
  setHostDefaultProfile,
} from "./profiles.mts";

const roots: string[] = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-profiles-"));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

test("loadProfiles returns an empty default when the profiles file does not exist", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");

  assert.deepEqual(await loadProfiles(profilesPath), {
    schemaVersion: 1,
    default: null,
    hostDefaults: {},
    profiles: {},
  });
});

test("saveProfiles and loadProfiles round-trip profile data", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  const data = {
    schemaVersion: 1,
    default: "codex",
    hostDefaults: {},
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/usr/local/bin/codex-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T17:30:00Z",
        installedVia: "registry",
        lastVerifiedAt: "2026-05-14T17:30:05Z",
      },
    },
  };

  await saveProfiles(profilesPath, data);

  assert.deepEqual(await loadProfiles(profilesPath), data);
});

test("loadProfiles rejects a wrong schema version", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({ schemaVersion: 2, default: null, profiles: {} }),
    "utf8",
  );

  await assert.rejects(loadProfiles(profilesPath), {
    code: "PROFILES_SCHEMA_MISMATCH",
  });
});

test("loadProfiles rejects non-object data", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(profilesPath, "null", "utf8");

  await assert.rejects(loadProfiles(profilesPath), {
    code: "PROFILES_MALFORMED",
  });
});

test("loadProfiles rejects missing profiles data", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({ schemaVersion: 1, default: null }),
    "utf8",
  );

  await assert.rejects(loadProfiles(profilesPath), {
    code: "PROFILES_MALFORMED",
  });
});

test("loadProfiles rejects an unknown default profile", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({ schemaVersion: 1, default: "codex", profiles: {} }),
    "utf8",
  );

  await assert.rejects(loadProfiles(profilesPath), {
    code: "PROFILES_MALFORMED",
  });
});

test("loadProfiles rejects a profile missing binary", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({
      schemaVersion: 1,
      default: "codex",
      profiles: {
        codex: {
          registryId: "codex",
          args: [],
          env: {},
          installedAt: "2026-05-14T17:30:00Z",
          installedVia: "registry",
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(loadProfiles(profilesPath), (error: ProfilesError) => {
    assert.equal(error.code, "PROFILES_MALFORMED");
    assert.equal(error.profileName, "codex");
    return true;
  });
});

test("loadProfiles rejects a non-object profile entry", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({
      schemaVersion: 1,
      default: "codex",
      profiles: {
        codex: null,
      },
    }),
    "utf8",
  );

  await assert.rejects(loadProfiles(profilesPath), (error: ProfilesError) => {
    assert.equal(error.code, "PROFILES_MALFORMED");
    assert.equal(error.profileName, "codex");
    assert.equal(error.path, profilesPath);
    return true;
  });
});

test("loadProfiles rejects unparseable JSON", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(profilesPath, "{", "utf8");

  await assert.rejects(loadProfiles(profilesPath), (error: ProfilesError) => {
    assert.equal(error.code, "PROFILES_MALFORMED");
    assert.equal(error.path, profilesPath);
    return true;
  });
});

test("setDefaultProfile rejects an unknown profile name", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await saveProfiles(profilesPath, {
    schemaVersion: 1,
    default: null,
    profiles: {},
  });

  await assert.rejects(setDefaultProfile(profilesPath, "codex"), {
    code: "UNKNOWN_PROFILE",
  });
});

test("setDefaultProfile updates the profiles file default", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await saveProfiles(profilesPath, {
    schemaVersion: 1,
    default: null,
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/usr/local/bin/codex-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T17:30:00Z",
        installedVia: "registry",
      },
    },
  });

  await setDefaultProfile(profilesPath, "codex");

  assert.equal((await loadProfiles(profilesPath)).default, "codex");
});

test("setHostDefaultProfile updates one host default", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await saveProfiles(profilesPath, {
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/usr/local/bin/codex-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T17:30:00Z",
      },
      claude: {
        registryId: "claude",
        binary: "/usr/local/bin/claude-agent-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T17:30:00Z",
      },
    },
  });

  await setHostDefaultProfile(profilesPath, "codex", "claude");

  assert.deepEqual((await loadProfiles(profilesPath)).hostDefaults, { codex: "claude" });
});

test("loadProfiles defaults installedVia to registry when absent", async () => {
  const profilesPath = path.join(makeRoot(), "profiles.json");
  await fsp.writeFile(
    profilesPath,
    JSON.stringify({
      schemaVersion: 1,
      default: "codex",
      profiles: {
        codex: {
          registryId: "codex",
          binary: "/usr/local/bin/codex-acp",
          args: [],
          env: {},
          installedAt: "2026-05-14T17:30:00Z",
        },
      },
    }),
    "utf8",
  );

  assert.equal((await loadProfiles(profilesPath)).profiles.codex.installedVia, "registry");
});
