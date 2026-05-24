import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

import { buildAgentLaunch } from "./process-sandbox.mjs";

const sessionUpdateStates = new WeakMap();

export async function newSession(connection, { cwd, mcpServers = [] }) {
  return await connection.newSession({ cwd, mcpServers });
}

export async function resumeSession(connection, { sessionId, cwd, mcpServers = [] }) {
  const resume = connection.resumeSession ?? connection.unstable_resumeSession;
  if (!resume) {
    throw new Error("ACP connection does not support session/resume");
  }
  return await resume.call(connection, { sessionId, cwd, mcpServers });
}

export async function loadSession(connection, { sessionId, cwd, mcpServers = [] }) {
  return await connection.loadSession({ sessionId, cwd, mcpServers });
}

export async function cancelPrompt(connection, { sessionId }) {
  return await connection.cancel({ sessionId });
}

export async function setSessionModel(connection, { sessionId, modelId }) {
  return await connection.unstable_setSessionModel({ sessionId, modelId });
}

export async function setSessionConfigOption(connection, params) {
  return await connection.setSessionConfigOption(params);
}

export async function* promptTurn(connection, { sessionId, prompt }) {
  const state = sessionUpdateStates.get(connection);
  if (!state) {
    throw new Error("Unknown ACP connection");
  }

  const queue = new SessionUpdateQueue();
  state.queues.set(sessionId, queue);

  let promptResult;
  const promptDone = connection
    .prompt({
      sessionId,
      prompt: normalizePrompt(prompt),
    })
    .then(
      (value) => {
        promptResult = { ok: true, value };
        return promptResult;
      },
      (error) => {
        promptResult = { ok: false, error };
        return promptResult;
      },
    );

  try {
    while (!promptResult || queue.hasValues()) {
      if (queue.hasValues()) {
        yield { type: "update", update: queue.shift() };
        continue;
      }

      const next = await Promise.race([
        queue.waitForValue().then(() => ({ type: "update" })),
        promptDone.then((result) => ({ type: "prompt", result })),
      ]);

      if (next.type === "update") {
        yield { type: "update", update: queue.shift() };
      } else if (!next.result.ok) {
        throw next.result.error;
      }
    }

    while (
      await Promise.race([
        queue.waitForValue().then(() => true),
        delay(10).then(() => false),
      ])
    ) {
      while (queue.hasValues()) {
        yield { type: "update", update: queue.shift() };
      }
    }

    yield { type: "stop", stopReason: promptResult.value.stopReason };
  } finally {
    if (state.queues.get(sessionId) === queue) {
      state.queues.delete(sessionId);
    }
  }
}

export async function startAgent({
  binary,
  args = [],
  env = {},
  cwd,
  clientHandlers = {},
  initTimeoutMs = 5000,
  sandbox = "off",
  workspaceRoot = cwd,
  mode = "read-only",
  profileRegistryId,
}) {
  const sessionUpdateState = { queues: new Map() };
  const launch = buildAgentLaunch({
    binary,
    args,
    cwd,
    env: { ...process.env, ...env },
    workspaceRoot,
    mode,
    sandbox,
    profileRegistryId,
  });
  const agentChild = spawn(launch.binary, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let alive = true;
  let stderr = "";

  agentChild.stderr.setEncoding("utf8");
  agentChild.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const stderrClosedPromise = new Promise((resolve) => {
    agentChild.stderr.once("close", resolve);
  });
  const exitPromise = new Promise((resolve) => {
    agentChild.once("exit", (code, signal) => {
      alive = false;
      resolve({ code, signal });
    });
  });

  const stream = ndJsonStream(
    Writable.toWeb(agentChild.stdin),
    Readable.toWeb(agentChild.stdout),
  );
  const connection = new ClientSideConnection(
    () => buildClient(clientHandlers, sessionUpdateState),
    stream,
  );
  sessionUpdateStates.set(connection, sessionUpdateState);
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = agentInitError("AGENT_INIT_TIMEOUT", stderr);
      if (alive) {
        agentChild.kill();
      }
      reject(error);
    }, initTimeoutMs);
  });

  let capabilities;
  try {
    const initializePromise = connection
      .initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      })
      .catch(async (error) => {
        if (alive) {
          await Promise.race([exitPromise, delay(50)]);
        }
        if (!alive) {
          await Promise.race([stderrClosedPromise, delay(50)]);
          throw agentInitError("AGENT_INIT_FAILED", stderr);
        }
        throw error;
      });

    capabilities = await Promise.race([
      initializePromise,
      exitPromise.then(async () => {
        await Promise.race([stderrClosedPromise, delay(50)]);
        throw agentInitError("AGENT_INIT_FAILED", stderr);
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }

  return {
    connection,
    capabilities,
    agentChild,
    async dispose() {
      agentChild.stdin.end();
      await waitForExit(agentChild, 250);
      if (alive) {
        agentChild.kill();
      }
      await onceExit(agentChild);
    },
  };
}

function buildClient(clientHandlers, sessionUpdateState) {
  return {
    requestPermission: handlerOrMissing(
      clientHandlers.requestPermission,
      "session/request_permission",
    ),
    sessionUpdate: async (params) => {
      const queue = sessionUpdateState.queues.get(params.sessionId);
      if (queue) {
        queue.push(params.update);
      }
      if (clientHandlers.sessionUpdate) {
        await clientHandlers.sessionUpdate(params);
      }
    },
    readTextFile: handlerOrMissing(
      clientHandlers.readTextFile,
      "fs/read_text_file",
    ),
    writeTextFile: handlerOrMissing(
      clientHandlers.writeTextFile,
      "fs/write_text_file",
    ),
    createTerminal: handlerOrMissing(
      clientHandlers.createTerminal,
      "terminal/create",
    ),
    terminalOutput: handlerOrMissing(
      clientHandlers.terminalOutput,
      "terminal/output",
    ),
    releaseTerminal: handlerOrMissing(
      clientHandlers.releaseTerminal,
      "terminal/release",
    ),
    waitForTerminalExit: handlerOrMissing(
      clientHandlers.waitForTerminalExit,
      "terminal/wait_for_exit",
    ),
    killTerminal: handlerOrMissing(
      clientHandlers.killTerminal,
      "terminal/kill",
    ),
    unstable_createElicitation: handlerOrMissing(
      clientHandlers.unstable_createElicitation,
      "elicitation/create",
    ),
    unstable_completeElicitation: handlerOrMissing(
      clientHandlers.unstable_completeElicitation,
      "elicitation/complete",
    ),
    extMethod: (method, params) => {
      if (clientHandlers.extMethod) {
        return clientHandlers.extMethod(method, params);
      }
      throw RequestError.methodNotFound(method);
    },
    extNotification: (method, params) => {
      if (clientHandlers.extNotification) {
        return clientHandlers.extNotification(method, params);
      }
      throw RequestError.methodNotFound(method);
    },
  };
}

function handlerOrMissing(handler, method) {
  if (handler) {
    return handler;
  }
  return async () => {
    throw RequestError.methodNotFound(method);
  };
}

function agentInitError(code, stderr) {
  const error = new Error(
    code === "AGENT_INIT_TIMEOUT"
      ? "Agent initialize timed out"
      : "Agent exited before initialize completed",
  );
  error.code = code;
  error.stderr = stderr;
  return error;
}

async function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    onceExit(child),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePrompt(prompt) {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  return prompt;
}

class SessionUpdateQueue {
  #updates = [];
  #waiters = [];

  push(update) {
    this.#updates.push(update);
    while (this.#waiters.length > 0) {
      this.#waiters.shift()();
    }
  }

  hasValues() {
    return this.#updates.length > 0;
  }

  shift() {
    return this.#updates.shift();
  }

  async waitForValue() {
    if (this.hasValues()) {
      return;
    }
    return await new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}
