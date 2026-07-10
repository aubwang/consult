#!/usr/bin/env node

import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StartedAgent } from "./lib/acp-client.mts";
import { brokerFilePath, jobsDir } from "./lib/broker-endpoint.mts";
import { createBrokerJobRuntime } from "./lib/broker-job-runtime.mts";
import {
  agentErrorMessage,
  canonicalizeRunParams,
  hashRunPayload,
  runAgentJobTurn,
  startJobAgent,
} from "./lib/job-agent.mts";
import type { AgentSessionState } from "./lib/job-agent.mts";
import {
  assertMatchingJobAuthority,
  jobAuthoritiesEqual,
  validateJobAuthority,
} from "./lib/job-authority.mts";
import type { JobAuthority } from "./lib/job-authority.mts";
import { readJsonlMessages } from "./lib/jsonl-framing.mts";
import { processStartTime } from "./lib/process-identity.mts";
import { normalizeAgentSandbox } from "./lib/process-sandbox.mts";
import { supportsLoad, supportsResume } from "./lib/session-controls.mts";
import { atomicWriteJson } from "./lib/state.mts";

export const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ServeBrokerOptions {
  endpoint: string;
  cwd: string;
  profile: string;
  binary: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  profileRegistryId?: string;
  jobId?: string | null;
  pidFile?: string;
  host?: string;
  hostSessionId?: string;
  cancelAckTimeoutMs?: number;
  finalizedShutdownGraceMs?: number;
  shutdownAfterJob?: boolean;
  idleTimeoutMs?: number | string | null;
  sandbox?: string;
  authority?: unknown;
}

export interface BrokerConfig extends ServeBrokerOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  profileRegistryId: string;
  jobId: string | null;
  host: string;
  hostSessionId: string;
  cancelAckTimeoutMs: number;
  finalizedShutdownGraceMs: number;
  shutdownAfterJob: boolean;
  idleTimeoutMs: number | null;
  sandbox: string;
  authority: JobAuthority | null;
}

export interface BrokerHandle {
  closed: Promise<{ code: number }>;
  endpoint: string;
  statePath: string;
  readonly tainted: boolean;
  shutdown: (code?: number) => Promise<{ code: number }>;
}

export interface ConsultRunParams {
  jobId: string;
  prompt: string;
  profile: string;
  authority?: JobAuthority;
  mode?: string;
  allowExecute?: boolean;
  resume?: string | null;
  model?: string | null;
  effort?: string | null;
  kind?: string;
  host?: string;
  hostSessionId?: string;
  submittedAt?: string;
  chainId?: string;
  parentJobId?: string | null;
  delegationDepth?: number;
  baseRef?: string;
}

type AgentHandle = StartedAgent;
type AgentCapabilities = AgentHandle["capabilities"];
type BrokerJobRuntime = ReturnType<typeof createBrokerJobRuntime>;
type BrokerJob = ReturnType<BrokerJobRuntime["createJob"]>;
type SessionState = AgentSessionState;

type JsonRpcId = string | number | null | undefined;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ConsultRunMessage {
  id?: JsonRpcId;
  params: ConsultRunParams;
}

interface CodedError extends Error {
  code?: string | number;
}

interface SocketBrokerContext {
  config: BrokerConfig;
  profile: string;
  startedAt: string;
  getCapabilities: () => AgentCapabilities | null;
  getSession: () => string | undefined;
  getSessionState?: () => SessionState | undefined;
  setSession: (sessionId: string, sessionState?: SessionState | null) => void;
  getJob: (jobId: string) => BrokerJob | undefined;
  createJob: (params: ConsultRunParams, originatorSocket: net.Socket) => BrokerJob;
  attachJob: (job: BrokerJob, targetSocket: net.Socket) => void;
  trackSession: (sessionId: string, job: BrokerJob) => void;
  finalizeJob: (job: BrokerJob, finalized: { stopReason: string; sessionId: string }) => Promise<void>;
  failJob: (job: BrokerJob, errorMessage: string) => Promise<void>;
  cancelJobCascade: (job: BrokerJob) => string[];
  noteTurnSettled: (job: BrokerJob) => void;
  isTainted: () => boolean;
  ensureAgent: (authority: JobAuthority, jobId?: string | null) => Promise<AgentHandle>;
  isBusy: () => boolean;
  setBusy: (value: boolean) => void;
  shutdown: () => Promise<{ code: number }>;
  touchActivity?: () => void;
}

export async function serveBroker(
  options: ServeBrokerOptions,
  { listen = listenOnSocket }: { listen?: typeof listenOnSocket } = {},
): Promise<BrokerHandle> {
  const config = normalizeOptions(options);
  const startedAt = new Date().toISOString();
  const sockets = new Set<net.Socket>();
  const socketSessions = new Map<net.Socket, string>();
  const socketSessionState = new Map<net.Socket, SessionState>();
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
    pidStartTime: await processStartTime(process.pid).catch(() => null),
    jobId: config.jobId,
    host: config.host,
    hostSessionId: config.hostSessionId,
    profile: config.profile,
    authority: config.authority,
    startedAt,
  };
  let shuttingDown = false;
  let agent: AgentHandle | null | undefined;
  let capabilities: AgentCapabilities | null = null;
  let agentAuthority: JobAuthority | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let finalizedShutdownTimer: NodeJS.Timeout | null = null;
  let closeResolve!: (result: { code: number }) => void;
  const closed = new Promise<{ code: number }>((resolve) => {
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
    // Abrupt disconnects (EPIPE/ECONNRESET) must clean up like a close, not
    // crash the daemon with an uncaught `error` event.
    socket.on("error", () => {
      socket.destroy();
    });
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
      trackSession: (sessionId, job) => runtime.trackSession(sessionId, job),
      finalizeJob: (job, finalized) => runtime.finalizeJob(job, finalized),
      failJob: (job, errorMessage) => runtime.failJob(job, errorMessage),
      cancelJobCascade: (job) => runtime.cancelJobCascade(job),
      noteTurnSettled: (job) => runtime.noteTurnSettled(job),
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
  // No peer auth exists on the socket (which may live in a shared tmpdir);
  // restrict it to the owning user.
  await fsp.chmod(config.endpoint, 0o600).catch((error: CodedError) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  scheduleIdleShutdown();

  async function shutdown(code = 0): Promise<{ code: number }> {
    if (shuttingDown) {
      return closed;
    }
    shuttingDown = true;
    clearIdleShutdown();
    clearFinalizedShutdown();
    for (const job of runtime.runningJobs()) {
      await runtime.failJob(job, "broker shut down before the job finalized").catch(() => {});
    }
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

  async function ensureAgent(
    authority: JobAuthority,
    jobId: string | null = null,
  ): Promise<AgentHandle> {
    if (agent && agentAuthority && !jobAuthoritiesEqual(agentAuthority, authority)) {
      await agent.dispose();
      agent = null;
      agentAuthority = null;
      capabilities = null;
      socketSessions.clear();
      socketSessionState.clear();
      runtime.clearSessions();
    }
    if (agent) {
      return agent;
    }
    agent = await startJobAgent({
      binary: config.binary,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      authority,
      sandbox: config.sandbox,
      profileRegistryId: config.profileRegistryId,
      jobId,
      runtime,
    });
    agentAuthority = authority;
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

function handleSocket(socket: net.Socket, broker: SocketBrokerContext): void {
  let buffer: Buffer = Buffer.alloc(0);
  let closing = false;
  socket.on("data", (chunk: Buffer) => {
    if (closing) {
      return;
    }
    broker.touchActivity?.();
    const framed = readJsonlMessages(buffer, chunk);
    buffer = framed.buffer;
    if (framed.error) {
      closing = true;
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: "MESSAGE_TOO_LARGE", message: framed.error.message },
        })}\n`,
        () => socket.end(),
      );
      return;
    }
    for (const line of framed.lines) {
      if (line === "") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        closing = true;
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

function handleMessage(socket: net.Socket, message: JsonRpcMessage, broker: SocketBrokerContext): void {
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
    const job = broker.getJob(params.jobId as string);
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
    handleRunMessage(socket, message as ConsultRunMessage, broker).catch((error) => {
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
    const job = broker.getJob(params.jobId as string);
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

async function handleRunMessage(
  socket: net.Socket,
  message: ConsultRunMessage,
  broker: SocketBrokerContext,
): Promise<void> {
  if (broker.isTainted()) {
    writeError(socket, message.id, {
      code: "BROKER_TAINTED",
      message: "broker is tainted after an unacknowledged cancel",
    });
    return;
  }
  const params = canonicalizeRunParams(message.params);
  if (broker.config.authority) {
    assertMatchingJobAuthority(params.authority, broker.config.authority);
  }
  const existingJob = broker.getJob(params.jobId);
  if (existingJob) {
    if (existingJob.status === "finalized") {
      writeError(socket, message.id, {
        code: "JOB_FINALIZED",
        message: "job is already finalized",
      });
      return;
    }
    if (existingJob.payloadHash !== hashRunPayload(params)) {
      writeError(socket, message.id, {
        code: "JOB_CONFLICT",
        message: "jobId is already running with a different payload",
      });
      return;
    }
    writeResult(socket, message.id, {
      accepted: true,
      jobId: params.jobId,
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

  broker.setBusy(true);
  try {
    if (params.resume) {
      const agent = await broker.ensureAgent(params.authority, params.jobId);
      if (!supportsResume(agent.capabilities) && !supportsLoad(agent.capabilities)) {
        writeError(socket, message.id, {
          code: "RESUME_UNSUPPORTED",
          message: `profile '${params.profile}' does not support delegate --resume: agent did not advertise session/resume or session/load`,
        });
        broker.setBusy(false);
        return;
      }
    }
  } catch (error) {
    broker.setBusy(false);
    throw error;
  }

  const job = broker.createJob(params, socket);
  broker.attachJob(job, socket);
  writeResult(socket, message.id, {
    accepted: true,
    jobId: params.jobId,
  });
  runAgentJobTurn(params, job, broker)
    .catch((error) => broker.failJob(job, agentErrorMessage(error)).catch(() => {}))
    .finally(() => {
      broker.setBusy(false);
    });
}

function writeResult(
  socket: net.Socket,
  id: JsonRpcId,
  result: unknown,
  callback?: (error?: Error | null) => void,
): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, callback);
}

function writeError(socket: net.Socket, id: JsonRpcId, error: { code: string | number; message: string }): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
}

function writeInvalidParams(socket: net.Socket, id: JsonRpcId): void {
  writeError(socket, id, {
    code: -32602,
    message: "invalid params",
  });
}

function writeNotification(socket: net.Socket, method: string, params: unknown): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function messageParams(message: JsonRpcMessage): Record<string, unknown> | null {
  if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
    return null;
  }
  return message.params as Record<string, unknown>;
}

function normalizeOptions(options: ServeBrokerOptions): BrokerConfig {
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
    authority: normalizeBrokerAuthority(options.authority),
  };
}

function normalizeBrokerAuthority(value: unknown): JobAuthority | null {
  if (value === undefined) {
    return null;
  }
  const result = validateJobAuthority(value);
  if (result.ok) {
    return result.authority;
  }
  const error = new Error(result.diagnostic.message) as CodedError & {
    diagnostic?: unknown;
  };
  error.code = result.diagnostic.code;
  error.diagnostic = result.diagnostic;
  throw error;
}

function resolveIdleTimeoutMs(
  optionValue: number | string | null | undefined,
  envValue: string | undefined,
): number | null {
  const raw = optionValue ?? envValue ?? DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid broker idle timeout: ${raw}`);
  }
  return parsed > 0 ? parsed : null;
}

async function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  // A broker that died ungracefully leaves its socket file behind; listening
  // over it would fail with EADDRINUSE forever.
  await fsp.unlink(socketPath).catch((error: CodedError) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export function parseArgs(argv: string[]): ServeBrokerOptions {
  const [command, ...tokens] = argv;
  if (command !== "serve") {
    throw new Error("usage: consult-broker.mts serve --endpoint <path> --cwd <ws> --profile <id> --binary <path>");
  }

  const parsed: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value: string | undefined = tokens[index + 1];
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
    authority: parsed.authority ? JSON.parse(parsed.authority) : undefined,
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
    if ((error as CodedError).code === "EADDRINUSE") {
      process.exit(2);
    }
    console.error((error as Error).message);
    process.exit(1);
  }
}
