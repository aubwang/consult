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

test("Claude and OpenAI family searches inspect native adapters, including configured aliases", async () => {
  const configured: ProfilesData = { schemaVersion: 1, default: "router", profiles: {
    router: profile("opencode"), reviewer: profile("claude"), coder: profile("codex"),
  } };
  for (const [match, registryId, model, id] of [
    ["claude", "claude", "sonnet", "reviewer"],
    ["anthropic", "claude", "fable-5.1", "reviewer"],
    ["fable", "claude", "fable-5.1", "reviewer"],
    ["fable 5.1", "claude", "fable 5.1", "reviewer"],
    ["opus[1m]", "claude", "opus[1m]", "reviewer"],
    ["OpenAI", "codex", "gpt-test", "coder"],
    ["gpt", "codex", "gpt-test", "coder"],
  ]) {
    const calls: string[] = [];
    const result = await runModels({ args: { positional: [], flags: { match, json: true } }, deps: {
      loadProfiles: async () => configured, workspace: async () => "/repo",
      discover: async (entry) => { calls.push(entry.registryId); return { source: "acp-session", models: [model] }; },
    } });
    const report = JSON.parse(result.stdout);
    assert.deepEqual(calls, [registryId]);
    assert.equal(result.exitCode, 0);
    assert.equal(report.models[0].profile, id);
    assert.equal(report.models[0].requiresExplicitInheritance, false);
    assert.equal(report.routing.preferredNativeProfile, registryId);
  }
});

test("a failed native probe does not offer opencode as a replacement", async () => {
  const calls: string[] = [];
  const result = await runModels({ args: { positional: [], flags: { match: "claude", json: true } }, deps: {
    loadProfiles: async () => profiles, workspace: async () => "/repo",
    discover: async (entry) => {
      calls.push(entry.registryId);
      if (entry.registryId === "claude") throw new Error("expired credential");
      return { source: "opencode-catalogue", models: ["openrouter/anthropic/claude-fable-5.1"] };
    },
  } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, ["claude"]);
  assert.deepEqual(JSON.parse(result.stdout).models, []);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "MODEL_DISCOVERY_FAILED");
});

test("missing native adapters produce setup guidance without launching another Profile", async () => {
  for (const match of ["claude", "openai"]) {
    const result = await runModels({ args: { positional: [], flags: { match, json: true } }, deps: {
      loadProfiles: async () => ({ schemaVersion: 1, default: "router", profiles: { router: profile("opencode") } }),
      workspace: async () => { throw new Error("must not resolve Workspace"); },
      discover: async () => { throw new Error("must not launch"); },
    } });
    const report = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(report.models, []);
    assert.equal(report.diagnostics[0].code, "NATIVE_PROFILE_NOT_CONFIGURED");
  }
});

test("broad discovery hides alternate native-family routes while explicit Profile selection preserves them", async () => {
  const catalogue = ["openrouter/anthropic/claude-fable-5.1", "openrouter/openai/gpt-test", "openrouter/x-ai/grok-4.6"];
  const deps = {
    loadProfiles: async (): Promise<ProfilesData> => ({ schemaVersion: 1, default: "router", profiles: { router: profile("opencode") } }),
    workspace: async () => "/repo",
    discover: async () => ({ source: "opencode-catalogue" as const, models: catalogue }),
  };
  const broad = JSON.parse((await runModels({ args: { positional: [], flags: { json: true } }, deps })).stdout);
  assert.deepEqual(broad.models.map((row: any) => row.model), [catalogue[2]]);
  assert.equal(broad.routing.omittedAlternateRoutes, 2);
  const explicit = JSON.parse((await runModels({ args: { positional: [], flags: { agent: "router", json: true } }, deps })).stdout);
  assert.deepEqual(explicit.models.map((row: any) => row.model), catalogue);
  assert.equal(explicit.routing.explicitProfile, "router");
});
