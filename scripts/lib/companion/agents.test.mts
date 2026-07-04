import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { profilesPath } from "../broker-endpoint.mts";
import { runAgents } from "./agents.mts";

test("agents lists setup guidance when no profiles are configured", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);

  const result = await runAgents({
    args: { positional: [], flags: {} },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\(no profiles configured; run 'consult setup'\)/);
});

test("agents exits 2 when --set is passed without a value", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: { set: true } },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "--set requires a value\n");
});

test("agents exits 2 when profiles are malformed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "missing",
    profiles: {},
  });

  const result = await runAgents({
    args: { positional: [], flags: {} },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, `profiles malformed: ${profilesPath()}\n`);
});

test("agents lists profiles and marks the default", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "claude",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
      claude: profileFixture({
        registryId: "claude-agent",
        binary: "/bin/claude-agent-acp",
        lastVerifiedAt: "2026-05-14T10:00:00.000Z",
      }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: {} },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /id\tregistryId\tbinary\tdefault\thostDefaults\tlastVerifiedAt/);
  assert.match(result.stdout, /codex\tcodex\t\/bin\/codex-acp\tno\t-\t-/);
  assert.match(
    result.stdout,
    /claude\tclaude-agent\t\/bin\/claude-agent-acp\tyes\t-\t2026-05-14T10:00:00.000Z/,
  );
});

test("agents set flips the default profile", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
      claude: profileFixture({ registryId: "claude-agent", binary: "/bin/claude-agent-acp" }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: { set: "claude" } },
    env: {},
    deps: {},
  });

  const profiles = JSON.parse(await fs.readFile(profilesPath(), "utf8"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "default set to claude\n");
  assert.equal(profiles.default, "claude");
});

test("agents set with host sets a host-specific default profile", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
      claude: profileFixture({ registryId: "claude-agent", binary: "/bin/claude-agent-acp" }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: { set: "claude", host: "codex" } },
    env: {},
    deps: {},
  });

  const profiles = JSON.parse(await fs.readFile(profilesPath(), "utf8"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "default for host codex set to claude\n");
  assert.deepEqual(profiles.hostDefaults, { codex: "claude" });
});

test("agents set exits 2 for an unknown profile", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: { set: "missing" } },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /no such profile: missing/);
});

test("agents json list mode emits a profile array", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-agents-"));
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: profileFixture({ registryId: "codex", binary: "/bin/codex-acp" }),
    },
  });

  const result = await runAgents({
    args: { positional: [], flags: { json: true } },
    env: {},
    deps: {},
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      id: "codex",
      registryId: "codex",
      binary: "/bin/codex-acp",
      default: true,
      hostDefaults: [],
      lastVerifiedAt: null,
    },
  ]);
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

async function writeProfiles(profiles: unknown): Promise<void> {
  await fs.mkdir(path.dirname(profilesPath()), { recursive: true });
  await fs.writeFile(profilesPath(), JSON.stringify(profiles));
}

function profileFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registryId: "codex",
    binary: "/bin/codex-acp",
    args: [],
    env: {},
    installedAt: "2026-05-14T09:00:00.000Z",
    ...overrides,
  };
}
