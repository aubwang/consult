import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProfilesData, ProfileRecord } from "../profiles.mts";
import { runModels } from "./models.mts";

function profile(registryId: string): ProfileRecord {
  return { registryId, binary: registryId, args: registryId === "opencode" ? ["acp"] : [], env: {}, installedAt: "2026-09-09" };
}
const profiles: ProfilesData = { schemaVersion: 1, default: null, profiles: {
  router: profile("opencode"), review: profile("claude"), custom: profile("custom"),
} };

test("model discovery returns exact matching routes without silently initializing inherited ACP Profiles", async () => {
  const calls: string[] = [];
  const result = await runModels({ args: { positional: [], flags: { match: "GROK", json: true } }, deps: {
    loadProfiles: async () => profiles, workspace: async () => "/repo", version: () => "1.4.0",
    discover: async (entry, cwd, sandbox) => {
      calls.push(entry.registryId);
      assert.equal(cwd, "/repo");
      assert.equal(sandbox, entry.registryId === "claude" ? "confined" : "inherit");
      return { source: "opencode-catalogue", models: entry.registryId === "opencode" ? ["openrouter/x-ai/grok-4.6", "openrouter/another"] : ["sonnet"] };
    },
  } });
  const report = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["claude", "opencode"]);
  assert.equal(report.version, "1.4.0");
  assert.equal(report.readiness, "advertised-only");
  assert.equal(report.complete, false);
  assert.equal(report.diagnostics[0].code, "INHERITANCE_REQUIRED");
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].profile, "router");
  assert.equal(report.models[0].requiresExplicitInheritance, true);
  assert.deepEqual(report.models[0].delegateArgs, ["delegate", "--agent", "router", "--model", "openrouter/x-ai/grok-4.6", "--read-only", "--sandbox", "inherit", "--json", "--prompt", "-"]);
});

test("discovery failures preserve other routes and do not echo provider secrets", async () => {
  const result = await runModels({ args: { positional: [], flags: { json: true } }, deps: {
    loadProfiles: async () => profiles, workspace: async () => "/repo",
    discover: async (entry) => {
      if (entry.registryId === "claude") throw new Error("synthetic-secret");
      return { source: "opencode-catalogue", models: ["provider/model"] };
    },
  } });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/u);
  assert.equal(JSON.parse(result.stdout).models.length, 1);
});

test("model filtering precedes pagination and explicit inheritance is scoped to one Profile", async () => {
  const result = await runModels({ args: { positional: [], flags: { agent: "custom", sandbox: "inherit", match: "match", limit: "1", offset: "1", json: true } }, deps: {
    loadProfiles: async () => profiles, workspace: async () => "/repo",
    discover: async (entry, _cwd, sandbox) => {
      assert.equal(entry.registryId, "custom"); assert.equal(sandbox, "inherit");
      return { source: "acp-session", models: ["exclude", "match1", "match2", "match3"] };
    },
  } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.total, 3); assert.equal(report.nextOffset, 2);
  assert.equal(report.models[0].model, "match2");
});

test("empty configuration needs no Workspace or subprocess and remains valid JSON", async () => {
  const result = await runModels({ args: { positional: [], flags: { json: true } }, deps: {
    loadProfiles: async () => ({ schemaVersion: 1, default: null, profiles: {} }),
    workspace: async () => { throw new Error("must not resolve Workspace"); },
  } });
  assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout).models, []);
});

test("invalid discovery arguments fail before reading configuration", async () => {
  for (const flags of [{ sandbox: "inherit" }, { match: "" }, { limit: "0" }, { offset: "-1" }, { json: "yes" }, { unexpected: true }]) {
    const result = await runModels({ args: { positional: [], flags }, deps: { loadProfiles: async () => { throw new Error("must not load"); } } });
    assert.equal(result.exitCode, 2);
  }
});
