import assert from "node:assert/strict";
import { test } from "node:test";

import type { Registry } from "./registry.mts";
import { buildStatusTable, probeBinaryOnPath } from "./setup-probe.mts";

test("probeBinaryOnPath reports a found binary path from deps", async () => {
  const result = await probeBinaryOnPath("codex-acp", {
    whichBinary: async () => "/fake/codex-acp",
  });

  assert.deepEqual(result, { found: true, path: "/fake/codex-acp" });
});

test("probeBinaryOnPath reports a missing binary from deps", async () => {
  const result = await probeBinaryOnPath("codex-acp", {
    whichBinary: async () => null,
  });

  assert.deepEqual(result, { found: false });
});

test("buildStatusTable marks a registry entry installed when it exists in profiles", async () => {
  const registry = registryFixture();
  registry.agents[0].notes = "Auth note";
  const profiles = {
    schemaVersion: 1,
    default: null,
    profiles: {
      codex: {
        registryId: "codex",
        binary: "/pinned/codex-acp",
        args: [],
        env: {},
        installedAt: "2026-05-14T10:00:00.000Z",
      },
    },
  };

  const rows = await buildStatusTable(registry, profiles, {
    whichBinary: async () => null,
  });

  assert.equal(rows.find((row) => row.id === "codex")!.installed, true);
  assert.equal(rows.find((row) => row.id === "codex")!.notes, "Auth note");
});

test("buildStatusTable marks the matching profile as default", async () => {
  const rows = await buildStatusTable(
    registryFixture(),
    {
      schemaVersion: 1,
      default: "codex",
      profiles: {
        codex: {
          registryId: "codex",
          binary: "/pinned/codex-acp",
          args: [],
          env: {},
          installedAt: "2026-05-14T10:00:00.000Z",
          lastVerifiedAt: "2026-05-14T10:01:00.000Z",
        },
      },
    },
    { whichBinary: async () => null },
  );

  const row = rows.find((entry) => entry.id === "codex")!;
  assert.equal(row.isDefault, true);
  assert.equal(row.lastVerifiedAt, "2026-05-14T10:01:00.000Z");
  assert.equal(row.notes, null);
});

function registryFixture(): Registry {
  return {
    schemaVersion: 1,
    agents: [
      {
        id: "codex",
        label: "Codex",
        binary: "codex-acp",
        args: [],
        install: { type: "cargo", cmd: "cargo install codex" },
        supports: { resume: true, load: true },
      },
    ],
  };
}
