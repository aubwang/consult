#!/usr/bin/env node

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  newSession,
  promptTurn,
  startAgent,
} from "./lib/acp-client.mjs";
import { brokerFilePath, jobsDir } from "./lib/broker-endpoint.mjs";
import { createBrokerJobRuntime } from "./lib/broker-job-runtime.mjs";
import { createFsHandlers } from "./lib/fs-handlers.mjs";
import { decidePermission } from "./lib/permissions.mjs";
import { normalizeAgentSandbox } from "./lib/process-sandbox.mjs";
import {
  applySessionControls,
  openResumedSession,
  supportsLoad,
  supportsResume,
} from "./lib/session-controls.mjs";
import { atomicWriteJson } from "./lib/state.mjs";

export const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export async function serveBroker(options, { listen = listenOnSocket } = {}) {
  const config = normalizeOptions(options);
  const startedAt = new Date().toISOString();
  const sockets = new Set();
  const socketSessions = new Map();
  const socketSessionState = new Map();
  const statePath = brokerFilePath({
    workspaceRoot: config.cwd,
    jobId: config.jobId,
    host: config.host,
    hostSessionId: config.hostSessionId,
    profile: config.profile,
  });
  const jobRecordsDir = jobsDir(config.cwd);
  const brokerState = {
    endpoint: config.endpoint,
    pid: process.pid,
    jobId: config.jobId,
    host: config.host,
    hostSessionId: config.hostSessionId,
    profile: config.profile,
    startedAt,
  };
  let shuttingDown = false;
  let agent;
  let capabilities = null;
  let agentMode = null;
  let idleTimer = null;
  let finalizedShutdownTimer = null;
  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  const runtime = createBrokerJobRuntime({
    config,
    ensureAgent,
    hashRunPayload,
    writeNotification,
    onActivity: () => scheduleIdleShutdown(),
    onTerminal: () => scheduleFinalizedShutdown(),
  });

  const server = net.createServer((socket) => {
    clearIdleShutdown();
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      socketSessions.delete(socket);
      socketSessionState.delete(socket);
      if (!shuttingDown) {
        runtime.handleSocketClosed(socket);
      }
      scheduleIdleShutdown();
    });
    handleSocket(socket, {
      config,
      profile: config.profile,
      startedAt,
      getCapabilities: () => capabilities,
      getSession: () => socketSessions.get(socket),
      getSessionState: () => socketSessionState.get(socket),
      setSession: (sessionId, sessionState = null) => {
        socketSessions.set(socket, sessionId);
        if (sessionState) {
          socketSessionState.set(socket, sessionState);
        }
      },
      getJob: (jobId) => runtime.getJob(jobId),
      createJob: (params, originatorSocket) => runtime.createJob(params, originatorSocket),
      attachJob: (job, targetSocket) => runtime.attachJob(job, targetSocket),
      trackSession: (sessionId, job, mode) => runtime.trackSession(sessionId, job, mode),
      finalizeJob: (job, finalized) => runtime.finalizeJob(job, finalized),
      failJob: (job, errorMessage) => runtime.failJob(job, errorMessage),
      cancelJobCascade: (job) => runtime.cancelJobCascade(job),
      isTainted: () => runtime.isTainted(),
      ensureAgent,
      isBusy: () => runtime.isBusy(),
      setBusy: (value) => runtime.setBusy(value),
      shutdown: () => shutdown(0),
      touchActivity: () => clearIdleShutdown(),
    });
  });

  await fsp.mkdir(path.dirname(config.endpoint), { recursive: true });
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.mkdir(jobRecordsDir, { recursive: true });
  if (config.pidFile) {
    await fsp.mkdir(path.dirname(config.pidFile), { recursive: true });
    await atomicWriteJson(config.pidFile, brokerState);
  }
  await atomicWriteJson(statePath, brokerState);
  await listen(server, config.endpoint);
  scheduleIdleShutdown();

  async function shutdown(code = 0) {
    if (shuttingDown) {
      return closed;
    }
    shuttingDown = true;
    clearIdleShutdown();
    clearFinalizedShutdown();
    for (const socket of sockets) {
      socket.destroy();
    }
    await agent?.dispose();
    runtime.clearSessions();
    await closeServer(server);
    await fsp.unlink(config.endpoint).catch(() => {});
    if (config.pidFile) {
      await fsp.unlink(config.pidFile).catch(() => {});
    }
    await fsp.unlink(statePath).catch(() => {});
    closeResolve({ code });
    return closed;
  }

  return {
    closed,
    endpoint: config.endpoint,
    statePath,
    get tainted() {
      return runtime.tainted;
    },
    shutdown,
  };

  async function ensureAgent(mode = "read-only") {
    if (agent && config.sandbox !== "off" && agentMode !== mode) {
      await agent.dispose();
      agent = null;
      agentMode = null;
      capabilities = null;
      socketSessions.clear();
      socketSessionState.clear();
      runtime.clearSessions();
    }
    if (agent) {
      return agent;
    }
    agent = await startAgent({
      binary: config.binary,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      workspaceRoot: config.cwd,
      mode,
      sandbox: config.sandbox,
      profileRegistryId: config.profileRegistryId,
      clientHandlers: {
        sessionUpdate: async ({ sessionId, update }) =>
          await runtime.handleSessionUpdate({ sessionId, update }),
        requestPermission: async ({ sessionId, ...request }) => {
          const decision = await decidePermission({
            request,
            mode: runtime.getSessionMode(sessionId) ?? "read-only",
            workspaceRoot: config.cwd,
          });
          runtime.notePermissionDecision({ sessionId, decision, request });
          return permissionResponse(decision, request.options);
        },
        readTextFile: async (request) => {
          const handlers = createFsHandlers({
            workspaceRoot: config.cwd,
            mode: runtime.getSessionMode(request.sessionId) ?? "read-only",
          });
          return await handlers.readTextFile(request);
        },
        writeTextFile: async (request) => {
          const handlers = createFsHandlers({
            workspaceRoot: config.cwd,
            mode: runtime.getSessionMode(request.sessionId) ?? "read-only",
          });
          return await handlers.writeTextFile(request);
        },
      },
    });
    agentMode = mode;
    capabilities = agent.capabilities;
    return agent;
  }

  function scheduleIdleShutdown() {
    clearIdleShutdown();
    if (!config.idleTimeoutMs || !isIdle()) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (isIdle()) {
        shutdown(0).catch(() => {});
        return;
      }
      scheduleIdleShutdown();
    }, config.idleTimeoutMs);
    idleTimer.unref?.();
  }

  function clearIdleShutdown() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleFinalizedShutdown() {
    if (!config.shutdownAfterJob || shuttingDown || finalizedShutdownTimer) {
      return;
    }
    finalizedShutdownTimer = setTimeout(() => {
      finalizedShutdownTimer = null;
      shutdown(0).catch(() => {});
    }, config.finalizedShutdownGraceMs);
    finalizedShutdownTimer.unref?.();
  }

  function clearFinalizedShutdown() {
    if (finalizedShutdownTimer) {
      clearTimeout(finalizedShutdownTimer);
      finalizedShutdownTimer = null;
    }
  }

  function isIdle() {
    return sockets.size === 0 && !runtime.isBusy() && !runtime.hasRunningJob();
  }
}

function handleSocket(socket, broker) {
  let buffer = "";
  socket.on("data", (chunk) => {
    broker.touchActivity?.();
    buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line === "") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "parse error" },
          })}\n`,
          () => socket.end(),
        );
        return;
      }
      handleMessage(socket, message, broker);
    }
  });
}

function handleMessage(socket, message, broker) {
  if (message.method === "consult/ping") {
    writeResult(socket, message.id, {
      ok: true,
      profile: broker.profile,
      startedAt: broker.startedAt,
      capabilities: broker.getCapabilities(),
    });
    return;
  }

  if (message.method === "broker/shutdown") {
    writeResult(socket, message.id, { ok: true }, () => broker.shutdown());
    return;
  }

  if (message.method === "consult/cancel") {
    const params = messageParams(message);
    if (!params) {
      writeInvalidParams(socket, message.id);
      return;
    }
    const job = broker.getJob(params.jobId);
    if (!job) {
      writeError(socket, message.id, {
        code: "UNKNOWN_JOB",
        message: "unknown jobId",
      });
      return;
    }
    if (job.status === "finalized") {
      const cascadedJobIds = broker.cancelJobCascade(job);
      writeResult(socket, message.id, {
        ok: true,
        alreadyFinalized: true,
        ...(cascadedJobIds.length > 0 ? { cascadedJobIds } : {}),
      });
      return;
    }
    const cascadedJobIds = broker.cancelJobCascade(job);
    writeResult(socket, message.id, {
      ok: true,
      ...(cascadedJobIds.length > 0 ? { cascadedJobIds } : {}),
    });
    return;
  }

  if (message.method === "consult/run") {
    if (!messageParams(message)) {
      writeInvalidParams(socket, message.id);
      return;
    }
    handleRunMessage(socket, message, broker).catch((error) => {
      writeError(socket, message.id, {
        code: error.code ?? "BROKER_ERROR",
        message: error.message,
      });
    });
    return;
  }

  if (message.method === "consult/attach") {
    const params = messageParams(message);
    if (!params) {
      writeInvalidParams(socket, message.id);
      return;
    }
    if (broker.isTainted()) {
      writeError(socket, message.id, {
        code: "BROKER_TAINTED",
        message: "broker is tainted after an unacknowledged cancel",
      });
      return;
    }
    const job = broker.getJob(params.jobId);
    if (!job) {
      writeError(socket, message.id, {
        code: "UNKNOWN_JOB",
        message: "unknown jobId",
      });
      return;
    }
    writeResult(socket, message.id, {
      attached: true,
      jobId: params.jobId,
    });
    broker.attachJob(job, socket);
    return;
  }

  writeError(socket, message.id, {
    code: -32601,
    message: `method not found: ${message.method}`,
  });
}

async function handleRunMessage(socket, message, broker) {
  if (broker.isTainted()) {
    writeError(socket, message.id, {
      code: "BROKER_TAINTED",
      message: "broker is tainted after an unacknowledged cancel",
    });
    return;
  }
  const existingJob = broker.getJob(message.params.jobId);
  if (existingJob) {
    if (existingJob.status === "finalized") {
      writeError(socket, message.id, {
        code: "JOB_FINALIZED",
        message: "job is already finalized",
      });
      return;
    }
    if (existingJob.payloadHash !== hashRunPayload(message.params)) {
      writeError(socket, message.id, {
        code: "JOB_CONFLICT",
        message: "jobId is already running with a different payload",
      });
      return;
    }
    writeResult(socket, message.id, {
      accepted: true,
      jobId: message.params.jobId,
    });
    broker.attachJob(existingJob, socket);
    return;
  }

  if (broker.isBusy()) {
    writeError(socket, message.id, {
      code: "BROKER_BUSY",
      message: "broker already has an in-flight prompt turn",
    });
    return;
  }

  if (message.params.resume) {
    const agent = await broker.ensureAgent();
    if (!supportsResume(agent.capabilities) && !supportsLoad(agent.capabilities)) {
      writeError(socket, message.id, {
        code: "RESUME_UNSUPPORTED",
        message: `profile '${message.params.profile}' does not support delegate --resume: agent did not advertise session/resume or session/load`,
      });
      return;
    }
  }

  if (broker.isBusy()) {
    writeError(socket, message.id, {
      code: "BROKER_BUSY",
      message: "broker already has an in-flight prompt turn",
    });
    return;
  }

  broker.setBusy(true);
  const job = broker.createJob(message.params, socket);
  broker.attachJob(job, socket);
  writeResult(socket, message.id, {
    accepted: true,
    jobId: message.params.jobId,
  });
  runJob(message.params, job, broker)
    .catch((error) => broker.failJob(job, agentErrorMessage(error)).catch(() => {}))
    .finally(() => {
      broker.setBusy(false);
    });
}

async function runJob(params, job, broker) {
  const agent = await broker.ensureAgent(params.mode ?? "read-only");
  let sessionId;
  let sessionState = null;
  if (job.resumeSessionId) {
    sessionState = await openResumedSession(agent.connection, agent.capabilities, {
      sessionId: job.resumeSessionId,
      cwd: broker.config.cwd,
    });
    sessionId = sessionState.sessionId ?? job.resumeSessionId;
    broker.setSession(sessionId, sessionState);
  } else {
    sessionId = broker.getSession();
    sessionState = broker.getSessionState?.() ?? null;
  }
  if (!sessionId) {
    sessionState = await newSession(agent.connection, {
      cwd: broker.config.cwd,
    });
    sessionId = sessionState.sessionId;
    broker.setSession(sessionId, sessionState);
  }
  broker.trackSession(sessionId, job, params.mode ?? "read-only");
  sessionState = await applySessionControls(agent.connection, {
    sessionId,
    sessionState,
    model: params.model,
    effort: params.effort,
    profile: params.profile,
  });
  broker.setSession(sessionId, sessionState);

  for await (const event of promptTurn(agent.connection, {
    sessionId,
    prompt: params.prompt,
  })) {
    if (event.type === "stop") {
      if (job.status !== "running") {
        continue;
      }
      broker.setBusy(false);
      await broker.finalizeJob(job, {
        stopReason: event.stopReason,
        sessionId,
      });
    }
  }
}

function agentErrorMessage(error) {
  if (error.code) {
    return `${error.code}: ${error.message}`;
  }
  return error.message;
}

function writeResult(socket, id, result, callback) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, callback);
}

function writeError(socket, id, error) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
}

function writeInvalidParams(socket, id) {
  writeError(socket, id, {
    code: -32602,
    message: "invalid params",
  });
}

function writeNotification(socket, method, params) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function messageParams(message) {
  if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
    return null;
  }
  return message.params;
}

function hashRunPayload(params) {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        prompt: params.prompt,
        profile: params.profile,
        mode: params.mode,
        resume: params.resume ?? null,
        model: params.model ?? null,
        effort: params.effort ?? null,
      }),
    )
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function permissionResponse(decision, options) {
  if (decision.allowed) {
    return {
      outcome: {
        outcome: "selected",
        optionId: optionIdFor(options, "allow") ?? "allow",
      },
    };
  }

  return {
    _meta: {
      reason: decision.reason,
    },
    outcome: {
      outcome: "selected",
      optionId: optionIdFor(options, "reject") ?? "reject",
    },
  };
}

function optionIdFor(options, action) {
  const prefix = action === "allow" ? "allow" : "reject";
  return options?.find((option) => option.kind?.startsWith(prefix))?.optionId;
}

function normalizeOptions(options) {
  return {
    ...options,
    args: options.args ?? [],
    env: options.env ?? {},
    profileRegistryId: options.profileRegistryId ?? options.profile,
    jobId: options.jobId || null,
    host: options.host ?? "terminal",
    hostSessionId: options.hostSessionId ?? "default",
    cancelAckTimeoutMs: options.cancelAckTimeoutMs ?? 2000,
    finalizedShutdownGraceMs: options.finalizedShutdownGraceMs ?? 25,
    shutdownAfterJob: options.shutdownAfterJob ?? Boolean(options.jobId),
    idleTimeoutMs: resolveIdleTimeoutMs(
      options.idleTimeoutMs,
      process.env.CONSULT_BROKER_IDLE_TIMEOUT_MS,
    ),
    sandbox: normalizeAgentSandbox(options.sandbox ?? process.env.CONSULT_AGENT_SANDBOX),
  };
}

function resolveIdleTimeoutMs(optionValue, envValue) {
  const raw = optionValue ?? envValue ?? DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid broker idle timeout: ${raw}`);
  }
  return parsed > 0 ? parsed : null;
}

async function listenOnSocket(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "serve") {
    throw new Error("usage: consult-broker.mjs serve --endpoint <path> --cwd <ws> --profile <id> --binary <path>");
  }

  const parsed = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${key ?? ""}`);
    }
    parsed[key.slice(2).replaceAll("-", "_")] = value;
  }

  for (const required of ["endpoint", "cwd", "profile", "binary"]) {
    if (!parsed[required]) {
      throw new Error(`missing required argument: --${required.replaceAll("_", "-")}`);
    }
  }

  return {
    endpoint: parsed.endpoint,
    cwd: parsed.cwd,
    profile: parsed.profile,
    binary: parsed.binary,
    args: parsed.args ? JSON.parse(parsed.args) : [],
    env: parsed.env ? JSON.parse(parsed.env) : {},
    profileRegistryId: parsed.registry_id,
    jobId: parsed.job_id || null,
    pidFile: parsed.pid_file,
    host: parsed.host,
    hostSessionId: parsed.host_session_id,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const broker = await serveBroker(parseArgs(process.argv.slice(2)));
    process.once("SIGTERM", () => broker.shutdown(0));
    process.once("SIGINT", () => broker.shutdown(0));
    const { code } = await broker.closed;
    process.exit(code);
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      process.exit(2);
    }
    console.error(error.message);
    process.exit(1);
  }
}
