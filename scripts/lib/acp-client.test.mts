import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type {
  AgentInitError,
  AgentLaunchLease,
  PromptTurnEvent,
} from "./acp-client.mts";
import {
  MAX_AGENT_STDERR_BYTES,
  loadSession,
  newSession,
  promptTurn,
  resumeSession,
  startAgent,
} from "./acp-client.mts";
import type { AgentLaunchOptions } from "./process-sandbox.mts";
import { pidIsAlive, terminateProcessGroup } from "./process.mts";

const fixturePath = fileURLToPath(
  new URL("./__fixtures__/fake-acp-agent.mts", import.meta.url),
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
    (thrown: unknown) => {
      const error = thrown as AgentInitError;
      assert.equal(error.code, "AGENT_INIT_TIMEOUT");
      assert.ok(Date.now() - startedAt < 400);
      return true;
    },
  );
});

test("startAgent surfaces a missing profile binary as AGENT_INIT_FAILED", async () => {
  let releases = 0;
  await assert.rejects(
    startAgent({
      binary: "/nonexistent/consult-missing-agent-binary",
      cwd: path.dirname(fixturePath),
      clientHandlers: {},
      initTimeoutMs: 2000,
    }, {
      acquireLaunch: async (options) => leaseFor(options, async () => {
        releases += 1;
      }),
    }),
    (thrown: unknown) => {
      const error = thrown as AgentInitError;
      assert.equal(error.code, "AGENT_INIT_FAILED");
      return true;
    },
  );
  assert.equal(releases, 1);
});

test("startAgent terminates the process group before releasing its launch lease", async () => {
  const events: string[] = [];
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "happy"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  }, {
    acquireLaunch: async (options) => leaseFor(options, async () => {
      events.push("release");
    }),
    terminateProcessGroup: async (pid, options) => {
      events.push("terminate");
      await terminateProcessGroup(pid, options);
    },
  });

  await Promise.all([agent.dispose(), agent.dispose()]);

  assert.deepEqual(events, ["terminate", "release"]);
});

test("startAgent archives Session state after termination and before releasing its launch lease", async () => {
  const events: string[] = [];
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "happy"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  }, {
    acquireLaunch: async (options) => ({
      ...leaseFor(options, async () => {
        events.push("release");
      }),
      archiveSessionState: async (input) => {
        events.push(`archive:${input.sessionId}`);
      },
    }),
    terminateProcessGroup: async (pid, options) => {
      events.push("terminate");
      await terminateProcessGroup(pid, options);
    },
  });

  await agent.dispose({
    archiveSessionState: { sessionId: "session-archive", cwd: "/workspace" },
  });

  assert.deepEqual(events, ["terminate", "archive:session-archive", "release"]);
});

test("failed process-group termination retains the launch lease", async () => {
  const events: string[] = [];
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "happy"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  }, {
    acquireLaunch: async (options) => leaseFor(options, async () => {
      events.push("release");
    }),
    terminateProcessGroup: async () => {
      events.push("terminate");
      throw new Error("termination not confirmed");
    },
  });

  try {
    await assert.rejects(agent.dispose(), /termination not confirmed/u);
    assert.deepEqual(events, ["terminate"]);
  } finally {
    if (agent.agentChild.pid !== undefined) {
      await terminateProcessGroup(agent.agentChild.pid, { timeoutMs: 500 }).catch(() => {});
    }
  }
});

test("dispose escalates to SIGKILL when the agent ignores SIGTERM", async () => {
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "stubborn"],
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });
  const exit = new Promise((resolve) => {
    agent.agentChild.once("exit", (code, signal) => resolve({ code, signal }));
  });

  await agent.dispose();

  assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
});

test("dispose terminates a Profile descendant after the direct child exits", async (t) => {
  const descendantPidPath = path.join(
    path.dirname(fixturePath),
    `.consult-descendant-${process.pid}-${Date.now()}`,
  );
  t.after(() => fs.promises.unlink(descendantPidPath).catch(() => {}));
  const agent = await startAgent({
    binary: process.execPath,
    args: [fixturePath, "descendant"],
    env: { CONSULT_FAKE_AGENT_DESCENDANT_PID_PATH: descendantPidPath },
    cwd: path.dirname(fixturePath),
    clientHandlers: {},
  });
  const descendantPid = await waitForPidFile(descendantPidPath);

  assert.equal(pidIsAlive(descendantPid), true);
  await agent.dispose();
  assert.equal(pidIsAlive(descendantPid), false);
});

test("startAgent rejects when the agent exits before initialize completes", async () => {
  await assert.rejects(
    startAgent({
      binary: process.execPath,
      args: [fixturePath, "exit"],
      cwd: path.dirname(fixturePath),
      clientHandlers: {},
    }),
    (thrown: unknown) => {
      const error = thrown as AgentInitError;
      assert.equal(error.code, "AGENT_INIT_FAILED");
      assert.match(error.stderr, /boom/);
      return true;
    },
  );
});

test("startAgent retains only a bounded stderr tail", async () => {
  await assert.rejects(
    startAgent({
      binary: process.execPath,
      args: [fixturePath, "exit-stderr-flood"],
      cwd: path.dirname(fixturePath),
      clientHandlers: {},
    }),
    (thrown: unknown) => {
      const error = thrown as AgentInitError;
      assert.equal(error.code, "AGENT_INIT_FAILED");
      assert.ok(Buffer.byteLength(error.stderr) <= MAX_AGENT_STDERR_BYTES);
      assert.doesNotMatch(error.stderr, /discarded-prefix/u);
      assert.match(error.stderr, /retained-suffix/u);
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
    const events: PromptTurnEvent[] = [];
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
    const events: PromptTurnEvent[] = [];
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
    const events: PromptTurnEvent[] = [];
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
  const handlerCalls: unknown[] = [];
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
    const events: PromptTurnEvent[] = [];
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

async function waitForPidFile(filePath: string): Promise<number> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      return Number(await fs.promises.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for descendant pid: ${filePath}`);
}

function leaseFor(
  options: AgentLaunchOptions,
  release: () => Promise<void>,
): AgentLaunchLease {
  return {
    launch: {
      binary: options.binary,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
    },
    release,
  };
}
