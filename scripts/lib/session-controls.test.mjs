import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applySessionControls,
  openResumedSession,
  supportsLoad,
  supportsResume,
} from "./session-controls.mjs";

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
  const calls = [];
  const connection = {
    async resumeSession(params) {
      calls.push(["resume", params]);
      return { sessionId: "resumed" };
    },
    async loadSession(params) {
      calls.push(["load", params]);
      return { sessionId: "loaded" };
    },
  };

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
  const calls = [];
  const connection = {
    async setSessionConfigOption(params) {
      calls.push(params);
      return {
        configOptions: [
          configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"]),
          configOption("thought", "Reasoning effort", "thought_level", ["low", "high"]),
        ],
      };
    },
  };
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

function configOption(id, name, category, values) {
  return {
    id,
    name,
    category,
    type: "select",
    options: values.map((value) => ({ name: value.replaceAll("-", " "), value })),
  };
}
