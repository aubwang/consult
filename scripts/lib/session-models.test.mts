import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSessionModels, sessionModelIds } from "./session-models.mts";
import type { AcpConnection } from "./acp-client.mts";

test("ACP model discovery handles both model state and grouped config options without inventing aliases", () => {
  assert.deepEqual(sessionModelIds({ models: { availableModels: ["grok", { modelId: "opus" }, { id: "grok" }, null, { modelId: "bad\nvalue" }] } }), ["grok", "opus"]);
  assert.deepEqual(sessionModelIds({ configOptions: [{ id: "model", options: [{ value: "provider/model" }, { options: [{ value: "provider/other" }] }] }] }), ["provider/model", "provider/other"]);
  assert.deepEqual(sessionModelIds({}), []);
});

test("model discovery creates a session but never sends a prompt or changes its model", async () => {
  const connection = { newSession: async (params: unknown) => {
    assert.deepEqual(params, { cwd: "/repo", mcpServers: [] });
    return { sessionId: "synthetic", models: { availableModels: [{ modelId: "model" }] } };
  } } as unknown as AcpConnection;
  assert.deepEqual(await discoverSessionModels(connection, "/repo"), ["model"]);
});

test("model discovery bounds a stalled session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = discoverSessionModels({ newSession: () => new Promise(() => {}) } as unknown as AcpConnection, "/repo");
  const rejected = assert.rejects(result, /timed out/u);
  t.mock.timers.tick(10_000);
  await rejected;
});
