import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadSession, newSession, promptTurn, resumeSession, startAgent } from "./acp-client.mjs";

const fixturePath = fileURLToPath(
  new URL("./__fixtures__/fake-acp-agent.mjs", import.meta.url),
);

test("startAgent initializes an ACP agent and disposes it cleanly", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "happy"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  assert.deepEqual(agent.capabilities.agentCapabilities, {
    loadSession: true,
    sessionCapabilities: {
      resume: {},
    },
  });

  const exit = new Promise((resolve) => {
    agent.agentChild.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await agent.dispose();

  assert.deepEqual(await exit, { code: 0, signal: null });
});

test(
  "startAgent can launch an ACP agent inside the bwrap filesystem sandbox",
  { skip: !fs.existsSync("/usr/bin/bwrap") },
  async () => {
    const repoRoot = path.resolve(path.dirname(fixturePath), "../../..");
    const agent = await startAgent({
      binary: process.execPath,
      args: [fixturePath, "happy"],
      cwd: path.dirname(fixturePath),
      workspaceRoot: repoRoot,
      mode: "read-only",
      sandbox: "bwrap",
      clientHandlers: {},
    });

    try {
      assert.deepEqual(agent.capabilities.agentCapabilities, {
        loadSession: true,
        sessionCapabilities: {
          resume: {},
        },
      });
    } finally {
      await agent.dispose();
    }
  },
);

test("startAgent rejects when initialize times out", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    startAgent({
      binary: process.execPath,
      args: [fixturePath, "hang"],
      cwd: path.dirname(fixturePath),
      clientHandlers: {},
      initTimeoutMs: 200,
    }),
    (error) => {
      assert.equal(error.code, "AGENT_INIT_TIMEOUT");
      assert.ok(Date.now() - startedAt < 400);
      return true;
    },
  );
});

test("startAgent rejects when the agent exits before initialize completes", async () => {
  await assert.rejects(
    startAgent({
      binary: process.execPath,
      args: [fixturePath, "exit"],
      cwd: path.dirname(fixturePath),
      clientHandlers: {},
    }),
    (error) => {
      assert.equal(error.code, "AGENT_INIT_FAILED");
      assert.match(error.stderr, /boom/);
      return true;
    },
  );
});

test("newSession returns a sessionId from the agent response", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    assert.deepEqual(
      await newSession(agent.connection, {
        cwd: "/tmp/workspace",
      }),
      { sessionId: "sess-1" },
    );
  } finally {
    await agent.dispose();
  }
});

test("resumeSession returns the requested resumed sessionId", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    assert.deepEqual(
      await resumeSession(agent.connection, {
        sessionId: "sess-prev",
        cwd: "/tmp/workspace",
      }),
      { sessionId: "sess-prev" },
    );
  } finally {
    await agent.dispose();
  }
});

test("loadSession returns the requested loaded sessionId", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions", "capabilities-load-only"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    assert.deepEqual(
      await loadSession(agent.connection, {
        sessionId: "sess-prev",
        cwd: "/tmp/workspace",
      }),
      { sessionId: "sess-prev" },
    );
  } finally {
    await agent.dispose();
  }
});

test("promptTurn yields session updates in order and a terminal stop event", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions", "prompt-updates"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    const events = [];
    for await (const event of promptTurn(agent.connection, {
      sessionId: "sess-1",
      prompt: "hello",
    })) {
      events.push(event);
    }

    assert.deepEqual(events, [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second" },
        },
      },
      { type: "stop", stopReason: "end_turn" },
    ]);
  } finally {
    await agent.dispose();
  }
});

test("promptTurn buffers updates sent before the prompt response resolves", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions", "prompt-pre-resolve-update"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    const events = [];
    for await (const event of promptTurn(agent.connection, {
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "hello" }],
    })) {
      events.push(event);
    }

    assert.deepEqual(events, [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "before-response" },
        },
      },
      { type: "stop", stopReason: "end_turn" },
    ]);
  } finally {
    await agent.dispose();
  }
});

test("promptTurn drains an update sent after the prompt response before stopping", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions", "prompt-post-resolve-update"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });

  try {
    const events = [];
    for await (const event of promptTurn(agent.connection, {
      sessionId: "sess-1",
      prompt: "hello",
    })) {
      events.push(event);
    }

    assert.deepEqual(events, [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after-response" },
        },
      },
      { type: "stop", stopReason: "end_turn" },
    ]);
  } finally {
    await agent.dispose();
  }
});

test("promptTurn fans out session updates to caller-supplied handlers", async () => {
  const handlerCalls = [];
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "sessions", "prompt-fanout"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {
      sessionUpdate: async (params) => {
        handlerCalls.push(params);
      },
    },
  });

  try {
    const events = [];
    for await (const event of promptTurn(agent.connection, {
      sessionId: "sess-1",
      prompt: "hello",
    })) {
      events.push(event);
    }

    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fanout" },
    };

    assert.deepEqual(events, [
      { type: "update", update },
      { type: "stop", stopReason: "end_turn" },
    ]);
    assert.deepEqual(handlerCalls, [{ sessionId: "sess-1", update }]);
  } finally {
    await agent.dispose();
  }
});
