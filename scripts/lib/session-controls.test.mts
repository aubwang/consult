import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpConnection } from "./acp-client.mts";
import {
  applySessionControls,
  normalizeModelControl,
  openResumedSession,
  supportsLoad,
  supportsResume,
} from "./session-controls.mts";

test("supportsResume accepts legacy and current capability shapes", () => {
  assert.equal(
    supportsResume({ agentCapabilities: { sessionCapabilities: { resume: {} } } }),
    true,
  );
  assert.equal(supportsResume({ agentCapabilities: { sessions: { resume: true } } }), true);
  assert.equal(supportsResume({ agentCapabilities: {} }), false);
});

test("supportsLoad reads the loadSession capability", () => {
  assert.equal(supportsLoad({ agentCapabilities: { loadSession: true } }), true);
  assert.equal(supportsLoad({ agentCapabilities: { loadSession: false } }), false);
});

test("openResumedSession prefers resume and falls back to load", async () => {
  const calls: Array<[string, unknown]> = [];
  const connection = {
    async resumeSession(params: unknown) {
      calls.push(["resume", params]);
      return { sessionId: "resumed" };
    },
    async loadSession(params: unknown) {
      calls.push(["load", params]);
      return { sessionId: "loaded" };
    },
  } as unknown as AcpConnection;

  assert.deepEqual(
    await openResumedSession(
      connection,
      { agentCapabilities: { sessions: { resume: true }, loadSession: true } },
      { sessionId: "session-1", cwd: "/workspace" },
    ),
    { sessionId: "resumed" },
  );
  assert.deepEqual(
    await openResumedSession(
      connection,
      { agentCapabilities: { loadSession: true } },
      { sessionId: "session-2", cwd: "/workspace" },
    ),
    { sessionId: "loaded" },
  );
  assert.deepEqual(calls.map(([method]) => method), ["resume", "load"]);
});

test("applySessionControls applies model and effort through select config options", async () => {
  const calls: unknown[] = [];
  const connection = {
    async setSessionConfigOption(params: unknown) {
      calls.push(params);
      return {
        configOptions: [
          configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"]),
          configOption("thought", "Reasoning effort", "thought_level", ["low", "high"]),
        ],
      };
    },
  } as unknown as AcpConnection;
  const sessionState = {
    configOptions: [
      configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"]),
      configOption("thought", "Reasoning effort", "thought_level", ["low", "high"]),
    ],
  };

  const nextState = await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState,
    model: "gpt 5 mini",
    effort: "high",
    profile: "codex",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", configId: "model", value: "gpt-5-mini" },
    { sessionId: "session-1", configId: "thought", value: "high" },
  ]);
  assert.deepEqual(nextState.configOptions, sessionState.configOptions);
});

test("applySessionControls expands current Claude model aliases", async () => {
  const calls: unknown[] = [];
  const connection = {
    async unstable_setSessionModel(params: unknown) {
      calls.push(params);
    },
  } as unknown as AcpConnection;

  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState: { models: {} },
    model: "opus",
    profile: "claude",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", modelId: "claude-opus-4-8" },
  ]);
});

test("normalizeModelControl maps Claude shorthand and leaves other profiles alone", () => {
  assert.equal(normalizeModelControl("claude", "opus-4.8"), "claude-opus-4-8");
  assert.equal(normalizeModelControl("claude", "sonnet"), "claude-sonnet-4-6");
  assert.equal(normalizeModelControl("claude", "haiku"), "claude-haiku-4-5");
  assert.equal(normalizeModelControl("claude", "custom-model"), "custom-model");
  assert.equal(normalizeModelControl("opencode", "opus"), "opus");
});

function configOption(id: string, name: string, category: string, values: string[]) {
  return {
    id,
    name,
    category,
    type: "select",
    options: values.map((value) => ({ name: value.replaceAll("-", " "), value })),
  };
}
