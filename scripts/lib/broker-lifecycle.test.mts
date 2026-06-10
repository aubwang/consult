import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  brokerSessionFilePresent,
  ensureBrokerSession,
  teardownBrokerSession,
} from "./broker-lifecycle.mts";
import { brokerFilePath, brokerSocketPath } from "./broker-endpoint.mts";
import { processStartTime } from "./process-identity.mts";
import { atomicWriteJson } from "./state.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.join(__dirname, "__fixtures__/fake-acp-agent.mts");
const socketBlockedMessage =
  "net.listen blocked in this sandbox; broker-lifecycle integration tests require a host with Unix socket privileges";

let socketListenBlocked = false;

before(async () => {
  socketListenBlocked = await probeSocketListenBlocked();
});

test("ensureBrokerSession spawns a fresh daemon and teardown shuts it down", async (t) => {
  if (socketListenBlocked) {
    return t.skip(socketBlockedMessage);
  }
  const harness = await createHarness(t);

  const session = await ensureBrokerSession(harness.input);
  t.after(async () => {
    await session.client.close().catch(() => {});
    await teardownBrokerSession(harness.input).catch(() => {});
  });

  assert.equal(session.brokerFile, harness.brokerFile);
  assert.equal(session.alreadyRunning, false);
  assert.equal(await brokerSessionFilePresent(harness.input), true);
  assert.equal(((await session.client.request("consult/ping", {}, { timeoutMs: 150 })) as { ok: boolean }).ok, true);

  assert.deepEqual(await teardownBrokerSession(harness.input), {
    teardown: "shutdown",
    brokerFile: harness.brokerFile,
  });
  assert.equal(await brokerSessionFilePresent(harness.input), false);
});

test("ensureBrokerSession reuses a live daemon recorded in the broker file", async (t) => {
  if (socketListenBlocked) {
    return t.skip(socketBlockedMessage);
  }
  const harness = await createHarness(t);
  const first = await ensureBrokerSession(harness.input);
  t.after(async () => {
    await first.client.close().catch(() => {});
    await teardownBrokerSession(harness.input).catch(() => {});
  });

  const second = await ensureBrokerSession(harness.input);
  t.after(async () => {
    await second.client.close().catch(() => {});
  });

  assert.equal(first.alreadyRunning, false);
  assert.equal(second.alreadyRunning, true);
  assert.equal(((await second.client.request("consult/ping", {}, { timeoutMs: 150 })) as { ok: boolean }).ok, true);
});

test("ensureBrokerSession replaces a stale broker file with a new daemon", async (t) => {
  if (socketListenBlocked) {
    return t.skip(socketBlockedMessage);
  }
  const harness = await createHarness(t);
  await fsp.mkdir(path.dirname(harness.brokerFile), { recursive: true });
  await atomicWriteJson(harness.brokerFile, {
    endpoint: brokerSocketPath(harness.input),
    pid: 999999999,
    jobId: harness.input.jobId,
    host: harness.input.host,
    profile: harness.input.profile,
    hostSessionId: harness.input.hostSessionId,
    startedAt: new Date(0).toISOString(),
  });

  const session = await ensureBrokerSession(harness.input);
  t.after(async () => {
    await session.client.close().catch(() => {});
    await teardownBrokerSession(harness.input).catch(() => {});
  });

  assert.equal(session.alreadyRunning, false);
  assert.equal(((await session.client.request("consult/ping", {}, { timeoutMs: 150 })) as { ok: boolean }).ok, true);
  const state = JSON.parse(await fsp.readFile(harness.brokerFile, "utf8"));
  assert.notEqual(state.pid, 999999999);
});

test("ensureBrokerSession replaces a malformed broker file with a new daemon", async (t) => {
  if (socketListenBlocked) {
    return t.skip(socketBlockedMessage);
  }
  const harness = await createHarness(t);
  await fsp.mkdir(path.dirname(harness.brokerFile), { recursive: true });
  await fsp.writeFile(harness.brokerFile, "{", "utf8");

  const session = await ensureBrokerSession(harness.input);
  t.after(async () => {
    await session.client.close().catch(() => {});
    await teardownBrokerSession(harness.input).catch(() => {});
  });

  assert.equal(session.alreadyRunning, false);
  assert.equal(((await session.client.request("consult/ping", {}, { timeoutMs: 150 })) as { ok: boolean }).ok, true);
  const state = JSON.parse(await fsp.readFile(harness.brokerFile, "utf8"));
  assert.equal(state.host, harness.input.host);
  assert.equal(state.profile, harness.input.profile);
  assert.equal(state.hostSessionId, harness.input.hostSessionId);
  assert.equal(state.jobId, harness.input.jobId);
});

test("ensureBrokerSession times out and cleans files when the daemon never listens", async (t) => {
  if (socketListenBlocked) {
    return t.skip(socketBlockedMessage);
  }
  const harness = await createHarness(t);
  const noListenScript = path.join(harness.dir, "no-listen.mjs");
  await fsp.writeFile(noListenScript, "process.stderr.write('no listen\\n');\n", "utf8");

  await assert.rejects(
    ensureBrokerSession({
      ...harness.input,
      options: {
        brokerScriptPath: noListenScript,
        spawnTimeoutMs: 200,
        sigtermTimeoutMs: 50,
      },
    }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "BROKER_SPAWN_TIMEOUT");
      assert.match(error.message, /no listen/);
      return true;
    },
  );
  assert.equal(await brokerSessionFilePresent(harness.input), false);
});

test("teardownBrokerSession is noop when no broker file exists", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual(await teardownBrokerSession(harness.input), {
    teardown: "noop",
    brokerFile: harness.brokerFile,
  });
});

test("teardownBrokerSession falls back to SIGTERM when shutdown RPC is unreachable", async (t) => {
  const harness = await createHarness(t);
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const sleeperExited = once(sleeper, "exit");
  const pidFile = `${harness.brokerFile.slice(0, -".json".length)}.pid.json`;
  t.after(() => {
    if (isPidAlive(sleeper.pid)) {
      sleeper.kill("SIGKILL");
    }
  });
  await fsp.mkdir(path.dirname(harness.brokerFile), { recursive: true });
  await atomicWriteJson(harness.brokerFile, {
    endpoint: path.join(harness.dir, "missing.sock"),
    pid: sleeper.pid,
    pidStartTime: await processStartTime(sleeper.pid),
    jobId: harness.input.jobId,
    host: harness.input.host,
    profile: harness.input.profile,
    hostSessionId: harness.input.hostSessionId,
    startedAt: new Date(0).toISOString(),
  });
  await atomicWriteJson(pidFile, { pid: sleeper.pid });

  assert.deepEqual(
    await teardownBrokerSession({
      ...harness.input,
      options: { shutdownTimeoutMs: 50, sigtermTimeoutMs: 200 },
    }),
    { teardown: "sigterm-tree", brokerFile: harness.brokerFile },
  );

  await sleeperExited;
  assert.equal(isPidAlive(sleeper.pid), false);
  assert.equal(await brokerSessionFilePresent(harness.input), false);
  assert.equal(await fileExists(pidFile), false);
});

test("teardownBrokerSession does not signal a mismatched reused pid", async (t) => {
  const harness = await createHarness(t);
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const pidFile = `${harness.brokerFile.slice(0, -".json".length)}.pid.json`;
  t.after(() => {
    if (isPidAlive(sleeper.pid)) {
      sleeper.kill("SIGKILL");
    }
  });
  await fsp.mkdir(path.dirname(harness.brokerFile), { recursive: true });
  await atomicWriteJson(harness.brokerFile, {
    endpoint: path.join(harness.dir, "missing.sock"),
    pid: sleeper.pid,
    pidStartTime: "not-this-process",
    jobId: harness.input.jobId,
    host: harness.input.host,
    profile: harness.input.profile,
    hostSessionId: harness.input.hostSessionId,
    startedAt: new Date(0).toISOString(),
  });
  await atomicWriteJson(pidFile, { pid: sleeper.pid });

  assert.deepEqual(
    await teardownBrokerSession({
      ...harness.input,
      options: { shutdownTimeoutMs: 50, sigtermTimeoutMs: 50 },
    }),
    { teardown: "stale", brokerFile: harness.brokerFile },
  );

  assert.equal(isPidAlive(sleeper.pid), true);
  assert.equal(await brokerSessionFilePresent(harness.input), false);
  assert.equal(await fileExists(pidFile), false);
});

async function createHarness(t: TestContext) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-lifecycle-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  const runtimeDir = path.join(dir, "runtime");
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  const oldRuntimeDir = process.env.XDG_RUNTIME_DIR;

  await fsp.mkdir(workspaceRoot);
  await fsp.mkdir(runtimeDir);
  process.env.CONSULT_DATA_DIR = dataDir;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  t.after(async () => {
    if (oldDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = oldDataDir;
    }
    if (oldRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = oldRuntimeDir;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const input = {
    workspaceRoot,
    jobId: "job-lifecycle",
    host: "claude-code",
    profile: "codex",
    hostSessionId: "claude-1",
    profileEntry: {
      binary: process.execPath,
      args: [fakeAgentPath, "sessions"],
      env: {},
    },
  };

  return {
    dir,
    input,
    brokerFile: brokerFilePath(input),
  };
}

function isPidAlive(pid: number | undefined) {
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function fileExists(filePath: string) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function probeSocketListenBlocked() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-net-probe-"));
  const socketPath = path.join(dir, "probe.sock");
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
