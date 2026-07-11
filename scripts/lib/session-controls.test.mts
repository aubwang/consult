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

test("applySessionControls applies model and max effort through select config options", async () => {
  const calls: unknown[] = [];
  const connection = {
    async setSessionConfigOption(params: unknown) {
      calls.push(params);
      return {
        configOptions: [
          configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"]),
          configOption("thought", "Reasoning effort", "thought_level", ["low", "max"]),
        ],
      };
    },
  } as unknown as AcpConnection;
  const sessionState = {
    configOptions: [
      configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"]),
      configOption("thought", "Reasoning effort", "thought_level", ["low", "max"]),
    ],
  };

  const nextState = await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState,
    model: "gpt 5 mini",
    effort: "max",
    profile: "codex",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", configId: "model", value: "gpt-5-mini" },
    { sessionId: "session-1", configId: "thought", value: "max" },
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

test("normalizeModelControl maps built-in Profile shorthand", () => {
  assert.equal(normalizeModelControl("claude", "opus-4.8"), "claude-opus-4-8");
  assert.equal(normalizeModelControl("claude", "sonnet"), "claude-sonnet-5");
  assert.equal(normalizeModelControl("claude", "haiku"), "claude-haiku-4-5");
  assert.equal(normalizeModelControl("claude", "fable"), "claude-fable-5");
  assert.equal(normalizeModelControl("claude", "custom-model"), "custom-model");
  assert.equal(normalizeModelControl("codex", "sol"), "gpt-5.6-sol");
  assert.equal(normalizeModelControl("codex", "terra"), "gpt-5.6-terra");
  assert.equal(normalizeModelControl("codex", "luna"), "gpt-5.6-luna");
  assert.equal(normalizeModelControl("opencode", "opus"), "opus");
});

test("applySessionControls resolves family aliases to the newest advertised model", async () => {
  const calls: unknown[] = [];
  const connection = {
    async unstable_setSessionModel(params: unknown) {
      calls.push(params);
    },
  } as unknown as AcpConnection;
  const sessionState = {
    models: {
      availableModels: [
        modelInfo("claude-sonnet-4-6"),
        modelInfo("claude-sonnet-5"),
        modelInfo("claude-haiku-4-5"),
        modelInfo("claude-haiku-4-5-20251001"),
        modelInfo("claude-opus-4-8"),
      ],
      currentModelId: "claude-sonnet-5",
    },
  };

  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState,
    model: "sonnet",
    profile: "claude",
  });
  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState,
    model: "haiku",
    profile: "claude",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", modelId: "claude-sonnet-5" },
    { sessionId: "session-1", modelId: "claude-haiku-4-5-20251001" },
  ]);
});

test("applySessionControls resolves advertised GPT-5.6 tier aliases", async () => {
  const calls: unknown[] = [];
  const connection = {
    async unstable_setSessionModel(params: unknown) {
      calls.push(params);
    },
  } as unknown as AcpConnection;
  const sessionState = {
    models: {
      availableModels: [
        modelInfo("gpt-5.6-sol"),
        modelInfo("gpt-5.6-terra"),
        modelInfo("gpt-5.6-luna"),
      ],
      currentModelId: "gpt-5.6-terra",
    },
  };

  for (const model of ["sol", "terra", "luna", "gpt-5.6-sol"]) {
    await applySessionControls(connection, {
      sessionId: "session-1",
      sessionState,
      model,
      profile: "codex",
    });
  }

  assert.deepEqual(calls, [
    { sessionId: "session-1", modelId: "gpt-5.6-sol" },
    { sessionId: "session-1", modelId: "gpt-5.6-terra" },
    { sessionId: "session-1", modelId: "gpt-5.6-luna" },
    { sessionId: "session-1", modelId: "gpt-5.6-sol" },
  ]);
});

test("applySessionControls never sends bare Codex tier aliases as model ids", async () => {
  const calls: unknown[] = [];
  const connection = {
    async setSessionConfigOption(params: unknown) {
      calls.push(params);
      return { configOptions: [] };
    },
  } as unknown as AcpConnection;

  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState: {
      configOptions: [
        configOption("model", "Model", "model", ["terra", "gpt-5.6-terra", "gpt-5.4"]),
      ],
    },
    model: "terra",
    profile: "codex",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", configId: "model", value: "gpt-5.6-terra" },
  ]);
});

test("applySessionControls keeps the Profile default when model is omitted", async () => {
  const connection = {
    async unstable_setSessionModel() {
      throw new Error("model selection should not be called");
    },
  } as unknown as AcpConnection;
  const sessionState = {
    models: {
      availableModels: [modelInfo("gpt-5.6-sol"), modelInfo("gpt-5.6-terra")],
      currentModelId: "gpt-5.6-sol",
    },
  };

  assert.equal(
    await applySessionControls(connection, {
      sessionId: "session-1",
      sessionState,
      profile: "codex",
    }),
    sessionState,
  );
});

test("applySessionControls passes exact advertised model ids through unchanged", async () => {
  const calls: unknown[] = [];
  const connection = {
    async unstable_setSessionModel(params: unknown) {
      calls.push(params);
    },
  } as unknown as AcpConnection;

  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState: {
      models: {
        availableModels: [modelInfo("claude-sonnet-4-6"), modelInfo("claude-sonnet-5")],
        currentModelId: "claude-sonnet-5",
      },
    },
    model: "claude-sonnet-4-6",
    profile: "claude",
  });

  assert.deepEqual(calls, [{ sessionId: "session-1", modelId: "claude-sonnet-4-6" }]);
});

test("applySessionControls resolves family aliases against select config options", async () => {
  const calls: unknown[] = [];
  const connection = {
    async setSessionConfigOption(params: unknown) {
      calls.push(params);
      return { configOptions: [] };
    },
  } as unknown as AcpConnection;

  await applySessionControls(connection, {
    sessionId: "session-1",
    sessionState: {
      configOptions: [
        configOption("model", "Model", "model", [
          "claude-sonnet-4-6",
          "claude-sonnet-5",
          "gpt-5",
        ]),
      ],
    },
    model: "sonnet",
    profile: "opencode",
  });

  assert.deepEqual(calls, [
    { sessionId: "session-1", configId: "model", value: "claude-sonnet-5" },
  ]);
});

test("applySessionControls still rejects unsupported models with available values", async () => {
  const connection = {
    async setSessionConfigOption() {
      throw new Error("should not be called");
    },
  } as unknown as AcpConnection;

  await assert.rejects(
    applySessionControls(connection, {
      sessionId: "session-1",
      sessionState: {
        configOptions: [configOption("model", "Model", "model", ["gpt-5", "gpt-5-mini"])],
      },
      model: "unknown-model-9",
      profile: "codex",
    }),
    /unsupported model 'unknown-model-9'; available values: gpt-5, gpt-5-mini/,
  );
});

function modelInfo(modelId: string) {
  return { modelId, name: modelId.replaceAll("-", " ") };
}

function configOption(id: string, name: string, category: string, values: string[]) {
  return {
    id,
    name,
    category,
    type: "select",
    options: values.map((value) => ({ name: value.replaceAll("-", " "), value })),
  };
}
