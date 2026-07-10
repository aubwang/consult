import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureSource = path.join(scriptsRoot, "package-confinement-fixture.mjs");
const FINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

export async function assertInstalledConfinedMatrix(binary, temporaryRoot, installer) {
  assertSupportedPlatform();
  for (const profile of ["codex", "claude"]) {
    const harness = await createHarness(binary, temporaryRoot, installer, profile);
    try {
      await runFullProfileMatrix(harness);
      await assertNoNewSandboxRoots(harness);
      process.stdout.write(`packed confined ${installer}/${profile} matrix passed\n`);
    } finally {
      await harness.close();
    }
  }
}

export async function assertInstalledConfinedDoctors(binary, temporaryRoot, installer) {
  assertSupportedPlatform();
  for (const profile of ["codex", "claude"]) {
    const harness = await createHarness(binary, temporaryRoot, installer, profile);
    try {
      await assertDoctor(harness);
      await assertNoNewSandboxRoots(harness);
      process.stdout.write(`packed confined ${installer}/${profile} Doctor passed\n`);
    } finally {
      await harness.close();
    }
  }
}

async function runFullProfileMatrix(harness) {
  await assertDoctor(harness);

  const source = await delegate(harness, "foreground", ["--read-only"]);
  assertCompleted(source, "foreground-ok");
  await assertMissing(path.join(harness.workspace, "read-only-attempt.txt"));
  await assertMissing(harness.hostWriteCanary);
  const sourceRecord = await readJobRecord(harness.data, source.job.id);
  assert.equal(sourceRecord.sessionStateArchived, true);

  const resumed = await delegate(harness, "resume", [
    "--read-only",
    "--resume-job",
    source.job.id,
  ]);
  assertCompleted(resumed, "resume-ok");
  const resumedRecord = await readJobRecord(harness.data, resumed.job.id);
  assert.equal(resumedRecord.resumeJobId, source.job.id);
  assert.equal(resumedRecord.resumeSessionId, source.outcome.sessionId);
  assert.equal(resumedRecord.sessionStateArchived, true);

  const writable = await delegate(harness, "write", ["--write"]);
  assertCompleted(writable, "write-ok");
  assert.equal(await fs.readFile(path.join(harness.workspace, "write-ok.txt"), "utf8"), "write-ok\n");
  await assertMissing(harness.hostWriteCanary);
  const writeProbe = await readJson(path.join(harness.workspace, ".probe-write.json"));
  await assertMissing(writeProbe.home);
  await fs.rm(path.join(harness.workspace, "write-ok.txt"));
  await fs.rm(path.join(harness.workspace, ".probe-write.json"));

  const isolated = await delegate(harness, "isolated", ["--write", "--isolated"]);
  assertCompleted(isolated, "isolated-ok");
  assert.deepEqual(isolated.artifacts.touchedFiles, ["isolated.txt"]);
  assert((isolated.artifacts.patchBytes ?? 0) > 0);
  assert.match(await fs.readFile(isolated.artifacts.patchPath, "utf8"), /isolated-ok/u);
  await assertMissing(path.join(harness.workspace, "isolated.txt"));
  const cleanup = await readJson(isolated.artifacts.cleanupMetadataPath);
  assert.equal(cleanup.status, "completed");
  await assertMissing(cleanup.executionRoot);

  const fetched = await delegate(harness, "fetch", ["--read-only", "--allow-fetch"]);
  assertCompleted(fetched, "fetch-ok");
  assert.equal(fetched.job.authority.allowFetch, true);
  assert.equal(fetched.job.authority.confinement, "confined");

  const backgroundQueued = await delegate(harness, "background", [
    "--read-only",
    "--background",
  ]);
  assert.equal(backgroundQueued.job.status, "queued");
  const background = await waitForFinal(harness, backgroundQueued.job.id);
  assertCompleted(background, "background-ok");
  const result = await commandJson(harness, ["result", background.job.id, "--json"]);
  assertCompleted(result, "background-ok");
  const backgroundRecord = await readJobRecord(harness.data, background.job.id);
  assert.equal(backgroundRecord.sessionStateArchived, true);
  await assertNoLiveBroker(harness, background.job.id);

  const cancelQueued = await delegate(harness, "cancel", ["--write", "--background"]);
  assert.equal(cancelQueued.job.status, "queued");
  const cancelProbePath = path.join(harness.workspace, ".probe-cancel.json");
  await waitForFile(cancelProbePath);
  const cancelProbe = await readJson(cancelProbePath);
  await waitForFile(cancelProbe.heartbeat);
  await command(harness, ["cancel", cancelQueued.job.id]);
  const cancelled = await waitForFinal(harness, cancelQueued.job.id);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.outcome.stopReason, "cancelled");
  const cancelRecord = await readJobRecord(harness.data, cancelQueued.job.id);
  assert.equal(cancelRecord.sessionStateArchived, true);
  await assertFileStoppedChanging(cancelProbe.heartbeat);
  await assertMissing(cancelProbe.home);
  await assertNoLiveBroker(harness, cancelQueued.job.id);
}

async function assertDoctor(harness) {
  const jobsBefore = await countJobRecords(harness.data);
  const report = await commandJson(harness, [
    "doctor",
    "--agent",
    harness.profileName,
    "--read-only",
    "--sandbox",
    "confined",
    "--json",
  ]);
  assert.equal(report.authority?.confined?.ok, true);
  assert.equal(report.authority?.profileRegistryId, harness.profile);
  assert.equal(await countJobRecords(harness.data), jobsBefore);
}

async function delegate(harness, scenario, authorityArgs) {
  const freshArgs = authorityArgs.includes("--resume-job") ? [] : ["--fresh"];
  return await commandJson(harness, [
    "delegate",
    "--agent",
    harness.profileName,
    ...authorityArgs,
    "--sandbox",
    "confined",
    ...freshArgs,
    "--json",
    "--",
    `package confinement scenario ${scenario}`,
  ]);
}

function assertCompleted(payload, marker) {
  assert.equal(payload.job?.status, "completed", payload.outcome?.errorMessage ?? marker);
  assert.equal(payload.outcome?.stopReason, "end_turn");
  assert.equal(payload.outcome?.finalText, marker);
}

async function createHarness(binary, temporaryRoot, installer, profile) {
  const sandboxRootsBefore = await listSandboxRoots();
  const root = path.join(temporaryRoot, `confined-${installer}-${profile}`);
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const sourceConfig = path.join(home, profile === "codex" ? ".codex" : ".claude");
  const hostReadCanary = path.join(root, "host-read-canary.txt");
  const hostWriteCanary = path.join(root, "host-write-canary.txt");
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(data, { recursive: true }),
    fs.mkdir(sourceConfig, { recursive: true }),
    fs.mkdir(path.join(home, ".npm", "_logs"), { recursive: true }),
    fs.mkdir(path.join(home, ".claude", "debug"), { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await fs.writeFile(path.join(workspace, "baseline.txt"), "baseline\n");
  const fixture = path.join(fakeBin, "package-confinement-fixture.mjs");
  await fs.copyFile(fixtureSource, fixture);
  await fs.chmod(fixture, 0o755);
  await fs.writeFile(hostReadCanary, "host-only\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(sourceConfig, profile === "codex" ? "auth.json" : ".credentials.json"),
    `${JSON.stringify({ probe: profile })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(sourceConfig, profile === "codex" ? "config.toml" : "settings.json"),
    "must not be staged\n",
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await run("git", ["init"], { cwd: workspace });
  await run("git", ["add", "baseline.txt"], { cwd: workspace });
  await run(
    "git",
    [
      "-c",
      "user.name=Consult Package Smoke",
      "-c",
      "user.email=package-smoke@example.invalid",
      "commit",
      "-m",
      "baseline",
    ],
    { cwd: workspace },
  );

  const sentinel = await startLoopbackSentinel();
  const profileName = `packed-${profile}`;
  const fixtureConfig = {
    profile,
    hostReadCanary,
    hostWriteCanary,
    sandboxRootsBefore,
    loopbackPort: sentinel.port,
  };
  const profileEnv = profile === "codex"
    ? { CODEX_HOME: sourceConfig }
    : { CLAUDE_CONFIG_DIR: sourceConfig };
  await fs.writeFile(
    path.join(data, "profiles.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      default: profileName,
      profiles: {
        [profileName]: {
          registryId: profile,
          binary: fixture,
          args: [JSON.stringify(fixtureConfig)],
          env: profileEnv,
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })}\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    CONSULT_DATA_DIR: data,
    CONSULT_PACKAGE_SECRET: "must-not-reach-profile",
    ...profileEnv,
    PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  return {
    binary,
    profile,
    profileName,
    root,
    workspace,
    data,
    hostWriteCanary,
    env,
    close: async () => await sentinel.close(),
  };
}

async function commandJson(harness, args) {
  const result = await command(harness, args);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `invalid JSON from ${args.join(" ")}: ${result.stdout || result.stderr}`,
      { cause: error },
    );
  }
}

async function command(harness, args) {
  return await run(harness.binary, args, {
    cwd: harness.workspace,
    env: harness.env,
    timeoutMs: 60_000,
  });
}

async function waitForFinal(harness, jobId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await commandJson(harness, ["status", jobId, "--json"]);
    if (FINAL_STATUSES.has(status.job?.status)) return status;
    await delay(100);
  }
  throw new Error(`Job ${jobId} did not finalize within 30 seconds`);
}

async function assertNoLiveBroker(harness, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const brokers = await commandJson(harness, ["brokers", "--json"]);
    if (!brokers.some((broker) => broker.jobId === jobId && broker.status === "running")) return;
    await delay(50);
  }
  throw new Error(`Broker for ${jobId} remained live after Job finalization`);
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.access(file);
      return;
    } catch {}
    await delay(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function assertFileStoppedChanging(file) {
  await delay(200);
  const before = (await fs.stat(file)).size;
  await delay(250);
  const after = (await fs.stat(file)).size;
  assert.equal(after, before, `descendant heartbeat continued after cleanup: ${file}`);
}

async function readJobRecord(data, jobId) {
  const matches = [];
  await walk(data, (file) => {
    if (path.basename(file) === `${jobId}.json`) matches.push(file);
  });
  assert.equal(matches.length, 1, `expected one record for ${jobId}, found ${matches.length}`);
  return await readJson(matches[0]);
}

async function countJobRecords(data) {
  let count = 0;
  await walk(data, (file) => {
    if (/[/\\]jobs[/\\]job-[A-Za-z0-9._-]+\.json$/u.test(file)) count += 1;
  });
  return count;
}

async function walk(directory, visit) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(candidate, visit);
    else if (entry.isFile()) visit(candidate);
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function assertMissing(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}

async function assertNoNewSandboxRoots(harness) {
  const after = await listSandboxRoots();
  const leaked = after.filter((entry) => !harness.sandboxRootsBefore.includes(entry));
  assert.deepEqual(leaked, [], `confined Job roots remained after packed matrix: ${leaked.join(", ")}`);
}

async function listSandboxRoots() {
  const entries = await fs.readdir("/tmp", { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("consult-srt-job-"))
    .map((entry) => entry.name)
    .sort();
}

async function startLoopbackSentinel() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    close: async () =>
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function assertSupportedPlatform() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("packed confined smoke is supported only on native Linux or macOS");
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(commandName, args, {
      cwd: scriptsRoot,
      env: process.env,
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      : null;
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${commandName} ${args.join(" ")} failed (${signal ?? `exit ${code}`}):\n${stderr || stdout}`,
        ),
      );
    });
  });
}
