import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brokerFilePath, brokerSocketPath } from "./broker-endpoint.mjs";
import { connectBroker } from "./broker-client.mjs";
import { pidMatchesStartTime } from "./process-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerScriptPath = path.resolve(__dirname, "../consult-broker.mjs");

export async function ensureBrokerSession({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
  profileEntry,
  options = {},
}) {
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
      options,
    });
    return { ...existing, alreadyRunning: true };
  } catch (error) {
    if (error.code !== "BROKER_UNREACHABLE" && error.code !== "BROKER_STATE_MALFORMED") {
      throw error;
    }
    if (error.code === "BROKER_STATE_MALFORMED") {
      await cleanupBrokerFiles(brokerFile, pidFile);
    } else if (await fileExists(brokerFile)) {
      await teardownBrokerSession({ workspaceRoot, jobId, host, hostSessionId, profile, options });
    }
  }

  const stderrFile = `${brokerFile}.stderr`;
  await fsp.mkdir(path.dirname(brokerFile), { recursive: true });
  const stderrHandle = await fsp.open(stderrFile, "w");
  let child;
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
      ],
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
  await cleanupBrokerFiles(brokerFile, pidFile);
  const stderr = await fsp.readFile(stderrFile, "utf8").catch(() => "");
  await fsp.unlink(stderrFile).catch(() => {});
  const error = new Error(
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
}) {
  const brokerFile = brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const pidFile = brokerPidFilePath(brokerFile);
  let state;
  try {
    state = await readJson(brokerFile);
  } catch (error) {
    if (error.code === "ENOENT") {
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
        return { teardown: "shutdown", brokerFile };
      }
    } catch {
      // Stale state is expected during get-or-spawn; fall through to process cleanup.
    }
  }

  let teardown = "stale";
  if (state.pid) {
    const result = await terminatePid(state.pid, options.sigtermTimeoutMs ?? 500, {
      pidStartTime: state.pidStartTime,
      requireIdentity: true,
    });
    if (result.signaled) {
      teardown = "sigterm-tree";
    }
  }
  await cleanupBrokerFiles(brokerFile, pidFile);
  return { teardown, brokerFile };
}

export async function connectBrokerSession({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
  options = {},
}) {
  const brokerFile = brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const endpoint = brokerSocketPath({ workspaceRoot, jobId, host, hostSessionId, profile });
  const pingTimeoutMs = options.pingTimeoutMs ?? 150;
  let state;
  try {
    state = await readJson(brokerFile);
  } catch (error) {
    const next = new Error(
      error.code === "ENOENT" ? "broker state file not found" : "broker state file is malformed",
    );
    next.code = error.code === "ENOENT" ? "BROKER_UNREACHABLE" : "BROKER_STATE_MALFORMED";
    throw next;
  }

  try {
    const client = await connectAndPing(state.endpoint ?? endpoint, pingTimeoutMs);
    return { client, brokerFile, state };
  } catch {
    const error = new Error("broker is unreachable");
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
}) {
  return await fileExists(brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile }));
}

async function tryReadyClient(brokerFile, endpoint, pingTimeoutMs) {
  if (!(await fileExists(brokerFile))) {
    return null;
  }

  try {
    return await connectAndPing(endpoint, pingTimeoutMs);
  } catch {
    return null;
  }
}

async function connectAndPing(endpoint, pingTimeoutMs) {
  let client;
  try {
    client = await connectBroker(endpoint, { connectTimeoutMs: pingTimeoutMs });
    await client.request("consult/ping", {}, { timeoutMs: 150 });
  } catch {
    await client?.close().catch(() => {});
    throw new Error("broker ping failed");
  }
  return client;
}

export function brokerPidFilePath(brokerFile) {
  return brokerFile.endsWith(".json")
    ? `${brokerFile.slice(0, -".json".length)}.pid.json`
    : `${brokerFile}.pid`;
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function cleanupBrokerFiles(brokerFile, pidFile = brokerPidFilePath(brokerFile)) {
  await Promise.all([
    fsp.unlink(brokerFile).catch(ignoreMissing),
    fsp.unlink(pidFile).catch(ignoreMissing),
  ]);
}

function ignoreMissing(error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

async function terminatePid(pid, timeoutMs, { pidStartTime, requireIdentity = false } = {}) {
  if (!pid || !(await pidAlive(pid))) {
    return { signaled: false };
  }
  if (requireIdentity && !(await pidMatchesStartTime(pid, pidStartTime))) {
    return { signaled: false };
  }
  signalPidTree(pid, "SIGTERM");
  await waitForPidExit(pid, timeoutMs);
  if (await pidAlive(pid)) {
    signalPidTree(pid, "SIGKILL");
    await waitForPidExit(pid, timeoutMs);
  }
  return { signaled: true };
}

function signalPidTree(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForExitOrMissing(pid, brokerFile, timeoutMs) {
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

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) {
      return;
    }
    await sleep(25);
  }
}

export async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
