import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brokerFilePath, brokerSocketPath } from "./broker-endpoint.mts";
import type { BrokerIdentity } from "./broker-endpoint.mts";
import { connectBroker } from "./broker-client.mts";
import type { BrokerClient } from "./broker-client.mts";
import { pidMatchesStartTime } from "./process-identity.mts";
import { pidIsAlive, terminateProcessTree } from "./process.mts";
import { jobAuthoritiesEqual } from "./job-authority.mts";
import type { JobAuthority } from "./job-authority.mts";

const brokerScriptPath = defaultBrokerScriptPath();

export function defaultBrokerScriptPath(moduleUrl: string = import.meta.url): string {
  const extension = moduleUrl.endsWith(".mts") ? ".mts" : ".mjs";
  return fileURLToPath(new URL(`../consult-broker${extension}`, moduleUrl));
}

export interface BrokerLifecycleOptions {
  pingTimeoutMs?: number;
  spawnTimeoutMs?: number;
  sigtermTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  brokerScriptPath?: string;
}

export interface BrokerProfileEntry {
  binary: string;
  args?: string[];
  env?: Record<string, string>;
  registryId?: string;
}

export interface BrokerLifecycleInput extends BrokerIdentity {
  authority?: JobAuthority;
  options?: BrokerLifecycleOptions;
}

export interface EnsureBrokerSessionInput extends BrokerLifecycleInput {
  authority: JobAuthority;
  profileEntry: BrokerProfileEntry;
}

export interface BrokerSessionState {
  endpoint?: string;
  pid?: number;
  pidStartTime?: string | null;
  agentPid?: number;
  agentPidStartTime?: string | null;
  authority?: unknown;
  [key: string]: unknown;
}

export interface ConnectBrokerSessionResult {
  client: BrokerClient;
  brokerFile: string;
  state: BrokerSessionState;
}

export interface EnsureBrokerSessionResult {
  client: BrokerClient;
  brokerFile: string;
  alreadyRunning: boolean;
  state?: BrokerSessionState;
}

export interface TeardownBrokerSessionResult {
  teardown: "noop" | "shutdown" | "stale" | "sigterm-tree";
  brokerFile: string;
}

interface CodedError extends Error {
  code?: string;
}

export async function ensureBrokerSession({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
  authority,
  profileEntry,
  options = {},
}: EnsureBrokerSessionInput): Promise<EnsureBrokerSessionResult> {
  const brokerFile = brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const endpoint = brokerSocketPath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const pingTimeoutMs = options.pingTimeoutMs ?? 150;
  const pidFile = brokerPidFilePath(brokerFile);

  try {
    const existing = await connectBrokerSession({
      workspaceRoot,
      jobId,
      host,
      hostSessionId,
      profile,
      authority,
      options,
    });
    return { ...existing, alreadyRunning: true };
  } catch (error) {
    const coded = error as CodedError;
    if (
      coded.code !== "BROKER_UNREACHABLE" &&
      coded.code !== "BROKER_STATE_MALFORMED" &&
      coded.code !== "BROKER_AUTHORITY_MISMATCH"
    ) {
      throw error;
    }
    if (coded.code === "BROKER_STATE_MALFORMED") {
      await cleanupBrokerFiles(brokerFile, pidFile);
    } else if (await fileExists(brokerFile)) {
      await teardownBrokerSession({ workspaceRoot, jobId, host, hostSessionId, profile, options });
    }
  }

  const stderrFile = `${brokerFile}.stderr`;
  await fsp.mkdir(path.dirname(brokerFile), { recursive: true });
  const stderrHandle = await fsp.open(stderrFile, "w");
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        options.brokerScriptPath ?? brokerScriptPath,
        "serve",
        "--endpoint",
        endpoint,
        "--cwd",
        workspaceRoot,
        "--profile",
        profile,
        "--job-id",
        jobId ?? "",
        "--binary",
        profileEntry.binary,
        "--args",
        JSON.stringify(profileEntry.args ?? []),
        "--env",
        JSON.stringify(profileEntry.env ?? {}),
        "--registry-id",
        profileEntry.registryId ?? profile,
        "--pid-file",
        pidFile,
        "--host",
        host,
        "--host-session-id",
        hostSessionId,
        "--authority",
        JSON.stringify(authority),
      ] as string[],
      {
        detached: true,
        stdio: ["ignore", "ignore", stderrHandle.fd],
      },
    );
  } finally {
    await stderrHandle.close();
  }
  child.unref();

  const deadline = Date.now() + (options.spawnTimeoutMs ?? 2000);
  while (Date.now() < deadline) {
    const client = await tryReadyClient(brokerFile, endpoint, pingTimeoutMs);
    if (client) {
      await fsp.unlink(stderrFile).catch(() => {});
      return { client, brokerFile, alreadyRunning: false };
    }
    await sleep(50);
  }

  await terminatePid(child.pid, options.sigtermTimeoutMs ?? 500);
  // A concurrent spawner may have won this identity; only remove files the
  // timed-out child actually owns.
  await cleanupBrokerFilesIfOwned(brokerFile, pidFile, child.pid);
  const stderr = await fsp.readFile(stderrFile, "utf8").catch(() => "");
  await fsp.unlink(stderrFile).catch(() => {});
  const error: CodedError = new Error(
    `Broker did not become ready before timeout${stderr ? `: ${stderr.trim()}` : ""}`,
  );
  error.code = "BROKER_SPAWN_TIMEOUT";
  throw error;
}

export async function teardownBrokerSession({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
  options = {},
}: BrokerLifecycleInput): Promise<TeardownBrokerSessionResult> {
  const brokerFile = brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const pidFile = brokerPidFilePath(brokerFile);
  let state: BrokerSessionState;
  try {
    state = await readJson(brokerFile);
  } catch (error) {
    if ((error as CodedError).code === "ENOENT") {
      return { teardown: "noop", brokerFile };
    }
    throw error;
  }

  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 500;
  const endpoint =
    state.endpoint ?? brokerSocketPath({ workspaceRoot, jobId, host, hostSessionId, profile });
  if (endpoint) {
    try {
      const client = await connectBroker(endpoint, { connectTimeoutMs: shutdownTimeoutMs });
      await client.request("broker/shutdown", {}, { timeoutMs: shutdownTimeoutMs });
      await waitForExitOrMissing(state.pid, brokerFile, shutdownTimeoutMs);
      if (!state.pid || !(await pidAlive(state.pid))) {
        await terminateAgentFromState(state, options.sigtermTimeoutMs ?? 500);
        return { teardown: "shutdown", brokerFile };
      }
    } catch {
      // Stale state is expected during get-or-spawn; fall through to process cleanup.
    }
  }

  let teardown: TeardownBrokerSessionResult["teardown"] = "stale";
  if (state.pid) {
    const result = await terminatePid(state.pid, options.sigtermTimeoutMs ?? 500, {
      pidStartTime: state.pidStartTime,
      requireIdentity: true,
    });
    if (result.signaled) {
      teardown = "sigterm-tree";
    }
  }
  await terminateAgentFromState(state, options.sigtermTimeoutMs ?? 500);
  await cleanupBrokerFilesIfOwned(brokerFile, pidFile, state.pid);
  return { teardown, brokerFile };
}

export async function connectBrokerSession({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
  authority,
  options = {},
}: BrokerLifecycleInput): Promise<ConnectBrokerSessionResult> {
  const brokerFile = brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const endpoint = brokerSocketPath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const pingTimeoutMs = options.pingTimeoutMs ?? 150;
  let state: BrokerSessionState;
  try {
    state = await readJson(brokerFile);
  } catch (error) {
    const next: CodedError = new Error(
      (error as CodedError).code === "ENOENT"
        ? "broker state file not found"
        : "broker state file is malformed",
    );
    next.code = (error as CodedError).code === "ENOENT" ? "BROKER_UNREACHABLE" : "BROKER_STATE_MALFORMED";
    throw next;
  }

  if (authority && !jobAuthoritiesEqual(state.authority, authority)) {
    const error: CodedError = new Error(
      "broker authority does not match the Job Authority selected before launch",
    );
    error.code = "BROKER_AUTHORITY_MISMATCH";
    throw error;
  }

  try {
    const client = await connectAndPing(state.endpoint ?? endpoint, pingTimeoutMs);
    return { client, brokerFile, state };
  } catch {
    const error: CodedError = new Error("broker is unreachable");
    error.code = "BROKER_UNREACHABLE";
    throw error;
  }
}

export async function brokerSessionFilePresent({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
}: BrokerIdentity): Promise<boolean> {
  return await fileExists(brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile }));
}

async function tryReadyClient(
  brokerFile: string,
  endpoint: string,
  pingTimeoutMs: number,
): Promise<BrokerClient | null> {
  if (!(await fileExists(brokerFile))) {
    return null;
  }

  try {
    return await connectAndPing(endpoint, pingTimeoutMs);
  } catch {
    return null;
  }
}

async function connectAndPing(endpoint: string, pingTimeoutMs: number): Promise<BrokerClient> {
  let client: BrokerClient | undefined;
  try {
    client = await connectBroker(endpoint, { connectTimeoutMs: pingTimeoutMs });
    await client.request("consult/ping", {}, { timeoutMs: pingTimeoutMs });
  } catch {
    await client?.close().catch(() => {});
    throw new Error("broker ping failed");
  }
  return client!;
}

export function brokerPidFilePath(brokerFile: string): string {
  return brokerFile.endsWith(".json")
    ? `${brokerFile.slice(0, -".json".length)}.pid.json`
    : `${brokerFile}.pid`;
}

async function readJson(filePath: string): Promise<BrokerSessionState> {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if ((error as CodedError).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function cleanupBrokerFiles(
  brokerFile: string,
  pidFile: string = brokerPidFilePath(brokerFile),
): Promise<void> {
  await Promise.all([
    fsp.unlink(brokerFile).catch(ignoreMissing),
    fsp.unlink(pidFile).catch(ignoreMissing),
  ]);
}

async function cleanupBrokerFilesIfOwned(
  brokerFile: string,
  pidFile: string,
  expectedPid: number | undefined,
): Promise<void> {
  await Promise.all([
    unlinkBrokerFileIfOwned(brokerFile, expectedPid),
    unlinkBrokerFileIfOwned(pidFile, expectedPid),
  ]);
}

async function unlinkBrokerFileIfOwned(
  filePath: string,
  expectedPid: number | undefined,
): Promise<void> {
  if (!expectedPid) {
    return;
  }
  const state = await readJson(filePath).catch(() => null);
  if (state?.pid !== expectedPid) {
    return;
  }
  await fsp.unlink(filePath).catch(ignoreMissing);
}

async function terminateAgentFromState(
  state: BrokerSessionState,
  timeoutMs: number,
): Promise<void> {
  await terminatePid(state.agentPid, timeoutMs, {
    pidStartTime: state.agentPidStartTime,
    requireIdentity: true,
  });
}

function ignoreMissing(error: unknown): void {
  if ((error as CodedError).code !== "ENOENT") {
    throw error;
  }
}

interface TerminatePidOptions {
  pidStartTime?: string | null;
  requireIdentity?: boolean;
}

async function terminatePid(
  pid: number | undefined,
  timeoutMs: number,
  { pidStartTime, requireIdentity = false }: TerminatePidOptions = {},
): Promise<{ signaled: boolean }> {
  if (!pid || !(await pidAlive(pid))) {
    return { signaled: false };
  }
  if (requireIdentity && !(await pidMatchesStartTime(pid, pidStartTime))) {
    return { signaled: false };
  }
  await terminateProcessTree(pid, { timeoutMs });
  return { signaled: true };
}

async function waitForExitOrMissing(
  pid: number | undefined,
  brokerFile: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = !pid || !(await pidAlive(pid));
    const missing = !(await fileExists(brokerFile));
    if (exited && missing) {
      return;
    }
    await sleep(25);
  }
}

export async function pidAlive(pid: number): Promise<boolean> {
  // Single liveness implementation: EPERM means the pid exists but is not ours.
  return pidIsAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
