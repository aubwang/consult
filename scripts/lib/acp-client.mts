import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelResponse,
  StopReason,
} from "@agentclientprotocol/sdk";

import { buildAgentLaunch } from "./process-sandbox.mts";
import type { AgentLaunch, AgentLaunchOptions } from "./process-sandbox.mts";
import { terminateProcessGroup as defaultTerminateProcessGroup } from "./process.mts";

export const MAX_AGENT_STDERR_BYTES = 64 * 1024;

// Some older ACP agents only expose resume through the unstable method name.
export type AcpConnection = ClientSideConnection & {
  unstable_resumeSession?: (params: ResumeSessionRequest) => Promise<ResumeSessionResponse>;
};

export type ClientHandlers = Partial<Client>;

export interface NewSessionParams {
  cwd: string;
  mcpServers?: McpServer[];
}

export interface ResumeSessionParams extends NewSessionParams {
  sessionId: string;
}

export type PromptTurnEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "stop"; stopReason: StopReason };

export interface AgentInitError extends Error {
  code: "AGENT_INIT_TIMEOUT" | "AGENT_INIT_FAILED";
  stderr: string;
}

export interface StartAgentOptions {
  binary: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  clientHandlers?: ClientHandlers;
  initTimeoutMs?: number;
  sandbox?: string;
  workspaceRoot?: string;
  mode?: string;
  profileRegistryId?: string;
  requestedModel?: string;
}

export interface AgentLaunchLease {
  launch: AgentLaunch;
  archiveSessionState?(input: { sessionId: string; cwd: string }): Promise<void>;
  release(): Promise<void>;
}

export type AcquireAgentLaunch = (
  options: AgentLaunchOptions,
) => Promise<AgentLaunchLease>;

export interface StartAgentDeps {
  acquireLaunch?: AcquireAgentLaunch;
  terminateProcessGroup?: typeof defaultTerminateProcessGroup;
}

export interface StartedAgent {
  connection: AcpConnection;
  capabilities: InitializeResponse;
  agentChild: ChildProcessByStdio<Writable, Readable, Readable>;
  dispose: (options?: {
    archiveSessionState?: { sessionId: string; cwd: string };
  }) => Promise<void>;
}

interface SessionUpdateState {
  queues: Map<string, SessionUpdateQueue>;
}

interface PromptTurnResolved {
  ok: true;
  value: PromptResponse;
}

interface PromptTurnRejected {
  ok: false;
  error: unknown;
}

type PromptTurnOutcome = PromptTurnResolved | PromptTurnRejected;

const sessionUpdateStates = new WeakMap<ClientSideConnection, SessionUpdateState>();
// Some ACP agents flush the final session/update just after session/prompt resolves.
const POST_PROMPT_UPDATE_DRAIN_IDLE_MS = 100;
// Bounded SIGTERM grace before dispose escalates to SIGKILL.
const DISPOSE_SIGTERM_TIMEOUT_MS = 500;

export async function newSession(
  connection: AcpConnection,
  { cwd, mcpServers = [] }: NewSessionParams,
): Promise<NewSessionResponse> {
  return await connection.newSession({ cwd, mcpServers });
}

export async function resumeSession(
  connection: AcpConnection,
  { sessionId, cwd, mcpServers = [] }: ResumeSessionParams,
): Promise<ResumeSessionResponse> {
  const resume = connection.resumeSession ?? connection.unstable_resumeSession;
  if (!resume) {
    throw new Error("ACP connection does not support session/resume");
  }
  return await resume.call(connection, { sessionId, cwd, mcpServers });
}

export async function loadSession(
  connection: AcpConnection,
  { sessionId, cwd, mcpServers = [] }: ResumeSessionParams,
): Promise<LoadSessionResponse> {
  return await connection.loadSession({ sessionId, cwd, mcpServers });
}

export async function cancelPrompt(
  connection: AcpConnection,
  { sessionId }: { sessionId: string },
): Promise<void> {
  return await connection.cancel({ sessionId });
}

export async function setSessionModel(
  connection: AcpConnection,
  { sessionId, modelId }: { sessionId: string; modelId: string },
): Promise<SetSessionModelResponse> {
  return await connection.unstable_setSessionModel({ sessionId, modelId });
}

export async function setSessionConfigOption(
  connection: AcpConnection,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  return await connection.setSessionConfigOption(params);
}

export async function* promptTurn(
  connection: AcpConnection,
  { sessionId, prompt }: { sessionId: string; prompt: string | ContentBlock[] },
): AsyncGenerator<PromptTurnEvent, void, undefined> {
  const state = sessionUpdateStates.get(connection);
  if (!state) {
    throw new Error("Unknown ACP connection");
  }

  const queue = new SessionUpdateQueue();
  state.queues.set(sessionId, queue);

  let promptResult: PromptTurnOutcome | undefined;
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
        yield { type: "update", update: queue.shift()! };
        continue;
      }

      const next = await Promise.race([
        queue.waitForValue().then(() => ({ type: "update" } as const)),
        promptDone.then((result) => ({ type: "prompt", result } as const)),
      ]);

      if (next.type === "update") {
        yield { type: "update", update: queue.shift()! };
      } else if (!next.result.ok) {
        throw next.result.error;
      }
    }

    while (
      await Promise.race([
        queue.waitForValue().then(() => true),
        delay(POST_PROMPT_UPDATE_DRAIN_IDLE_MS).then(() => false),
      ])
    ) {
      while (queue.hasValues()) {
        yield { type: "update", update: queue.shift()! };
      }
    }

    yield { type: "stop", stopReason: (promptResult as PromptTurnResolved).value.stopReason };
  } finally {
    if (state.queues.get(sessionId) === queue) {
      state.queues.delete(sessionId);
    }
  }
}

export async function startAgent(
  {
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
    requestedModel,
  }: StartAgentOptions,
  deps: StartAgentDeps = {},
): Promise<StartedAgent> {
  const sessionUpdateState: SessionUpdateState = { queues: new Map() };
  const lease = await (deps.acquireLaunch ?? acquireLegacyAgentLaunch)({
    binary,
    args,
    cwd,
    env: { ...process.env, ...env },
    workspaceRoot,
    mode,
    sandbox,
    profileRegistryId,
    requestedModel,
  });
  const { launch } = lease;
  let releasePromise: Promise<void> | undefined;
  const releaseLease = (): Promise<void> => {
    releasePromise ??= lease.release();
    return releasePromise;
  };
  let agentChild: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    agentChild = spawn(launch.binary, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    try {
      await releaseLease();
    } catch (cleanupError) {
      noteCleanupFailure(error, cleanupError);
    }
    throw error;
  }
  const processGroupId = process.platform === "win32" ? undefined : agentChild.pid;
  let alive = true;
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  agentChild.stderr.on("data", (chunk: Buffer | string) => {
    stderr = appendStderrTail(stderr, chunk);
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
  // spawn failures (for example a missing binary) emit `error` instead of `exit`.
  const spawnErrorPromise = new Promise<Error>((resolve) => {
    agentChild.once("error", (error) => {
      alive = false;
      resolve(error);
    });
  });

  let timeoutId: NodeJS.Timeout | undefined;
  let disposePromise: Promise<void> | undefined;
  try {
    const stream = ndJsonStream(
      Writable.toWeb(agentChild.stdin),
      Readable.toWeb(agentChild.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(
      () => buildClient(clientHandlers, sessionUpdateState),
      stream,
    );
    sessionUpdateStates.set(connection, sessionUpdateState);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = agentInitError("AGENT_INIT_TIMEOUT", stderr.toString("utf8"));
        reject(error);
      }, initTimeoutMs);
    });
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
          throw agentInitError("AGENT_INIT_FAILED", stderr.toString("utf8"));
        }
        throw error;
      });

    const capabilities = await Promise.race([
      initializePromise,
      exitPromise.then(async () => {
        await Promise.race([stderrClosedPromise, delay(50)]);
        throw agentInitError("AGENT_INIT_FAILED", stderr.toString("utf8"));
      }),
      spawnErrorPromise.then((error) => {
        throw agentInitError(
          "AGENT_INIT_FAILED",
          stderr.length > 0 ? stderr.toString("utf8") : error.message,
        );
      }),
      timeoutPromise,
    ]);

    return {
      connection,
      capabilities,
      agentChild,
      dispose: async (options) => await disposeAgentChild(true, options),
    };
  } catch (error) {
    try {
      await disposeAgentChild(false);
    } catch (cleanupError) {
      noteCleanupFailure(error, cleanupError);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  async function disposeAgentChild(
    graceful: boolean,
    options?: { archiveSessionState?: { sessionId: string; cwd: string } },
  ): Promise<void> {
    disposePromise ??= (async () => {
      let processTerminated = agentChild.pid === undefined;
      try {
        if (agentChild.pid === undefined) {
          agentChild.stdin.destroy();
          return;
        }
        if (graceful && !agentChild.stdin.destroyed) {
          agentChild.stdin.end();
          await waitForExit(agentChild, 250);
        }
        if (processGroupId !== undefined) {
          await (deps.terminateProcessGroup ?? defaultTerminateProcessGroup)(processGroupId, {
            timeoutMs: DISPOSE_SIGTERM_TIMEOUT_MS,
          });
        } else {
          if (alive) {
            agentChild.kill();
            await waitForExit(agentChild, DISPOSE_SIGTERM_TIMEOUT_MS);
          }
          if (alive) {
            agentChild.kill("SIGKILL");
          }
        }
        await onceExit(agentChild);
        processTerminated = true;
        if (options?.archiveSessionState) {
          if (!lease.archiveSessionState) {
            throw new Error(
              "SESSION_STATE_ARCHIVE_FAILED: confined launch does not support selective Session archival",
            );
          }
          await lease.archiveSessionState(options.archiveSessionState);
        }
      } finally {
        if (processTerminated) {
          await releaseLease();
        }
      }
    })();
    await disposePromise;
  }

}

function appendStderrTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike> | string,
): Buffer<ArrayBufferLike> {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (incoming.length >= MAX_AGENT_STDERR_BYTES) {
    return incoming.subarray(incoming.length - MAX_AGENT_STDERR_BYTES);
  }
  if (current.length + incoming.length <= MAX_AGENT_STDERR_BYTES) {
    return Buffer.concat([current, incoming]);
  }
  const keep = MAX_AGENT_STDERR_BYTES - incoming.length;
  return Buffer.concat([current.subarray(current.length - keep), incoming]);
}

async function acquireLegacyAgentLaunch(
  options: AgentLaunchOptions,
): Promise<AgentLaunchLease> {
  return {
    launch: buildAgentLaunch(options),
    release: async () => {},
  };
}

function noteCleanupFailure(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) {
    return;
  }
  Object.defineProperty(primary, "cleanupError", {
    configurable: true,
    enumerable: false,
    value: cleanup,
  });
}

function buildClient(clientHandlers: ClientHandlers, sessionUpdateState: SessionUpdateState): Client {
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

function handlerOrMissing<T>(handler: T | undefined, method: string): T | (() => Promise<never>) {
  if (handler) {
    return handler;
  }
  return async () => {
    throw RequestError.methodNotFound(method);
  };
}

function agentInitError(code: AgentInitError["code"], stderr: string): AgentInitError {
  const error = new Error(
    code === "AGENT_INIT_TIMEOUT"
      ? "Agent initialize timed out"
      : "Agent exited before initialize completed",
  ) as AgentInitError;
  error.code = code;
  error.stderr = stderr;
  return error;
}

async function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    onceExit(child),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePrompt(prompt: string | ContentBlock[]): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  return prompt;
}

class SessionUpdateQueue {
  #updates: SessionUpdate[] = [];
  #waiters: Array<(value: void | PromiseLike<void>) => void> = [];

  push(update: SessionUpdate): void {
    this.#updates.push(update);
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!();
    }
  }

  hasValues(): boolean {
    return this.#updates.length > 0;
  }

  shift(): SessionUpdate | undefined {
    return this.#updates.shift();
  }

  async waitForValue(): Promise<void> {
    if (this.hasValues()) {
      return;
    }
    return await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}
