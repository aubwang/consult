#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brokersDir, jobsDir, profilesPath } from "./lib/broker-endpoint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const companionPath = path.join(__dirname, "consult-companion.mjs");
const fakeAgentPath = path.join(__dirname, "lib", "__fixtures__", "fake-acp-agent.mjs");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-disconnect-drill-"));
const workspaceRoot = path.join(root, "workspace");
const dataDir = path.join(root, "data");
const cancelLog = path.join(root, "cancel.ndjson");
const stdout = [];
const stderr = [];
let companion;
let companionExited = false;

try {
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  process.env.CONSULT_DATA_DIR = dataDir;
  await fs.writeFile(
    profilesPath(),
    JSON.stringify({
      schemaVersion: 1,
      default: "fake",
      hostDefaults: {},
      profiles: {
        fake: {
          registryId: "fake",
          binary: process.execPath,
          args: [fakeAgentPath, "sessions", "prompt-cancel-ack"],
          env: {
            CONSULT_FAKE_AGENT_CANCEL_LOG: cancelLog,
          },
          installedAt: new Date(0).toISOString(),
          installedVia: "manual",
        },
      },
    }),
    "utf8",
  );

  companion = spawn(
    process.execPath,
    [companionPath, "delegate", "--agent", "fake", "--write", "--", "start slow work"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CONSULT_DATA_DIR: dataDir,
        CONSULT_HOST: "drill",
        CONSULT_HOST_SESSION_ID: "companion-disconnect",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  companion.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
  companion.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  companion.on("exit", () => {
    companionExited = true;
  });

  const jobId = await waitForJobId();
  await waitFor(() => stdout.join("").includes("slow"), "delegate did not stream slow update");

  companion.kill("SIGKILL");
  await waitForExit(companion);

  const record = await waitForJobRecord(jobId, (value) => value.status === "cancelled");
  assert.equal(record.stopReason, "cancelled");
  assert.equal(record.sessionId, "sess-1");
  assert.equal(await lineCount(cancelLog), 1);
  await waitForNoBrokerFiles();

  process.stdout.write(
    [
      "companion disconnect drill passed",
      `workspace: ${workspaceRoot}`,
      `dataDir: ${dataDir}`,
      `jobId: ${jobId}`,
      `status: ${record.status}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.stderr.write(`stdout: ${stdout.join("")}\n`);
  process.stderr.write(`stderr: ${stderr.join("")}\n`);
  process.stderr.write(`workspace: ${workspaceRoot}\n`);
  process.stderr.write(`dataDir: ${dataDir}\n`);
  process.exitCode = 1;
} finally {
  if (companion && !companionExited) {
    companion.kill("SIGKILL");
    await waitForExit(companion);
  }
  if (!process.exitCode) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function waitForJobId() {
  return await waitFor(async () => {
    const entries = await fs.readdir(jobsDir(workspaceRoot)).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const jobEntry = entries.find((entry) => entry.endsWith(".json"));
    return jobEntry ? path.basename(jobEntry, ".json") : null;
  }, "job record was not created");
}

async function waitForJobRecord(jobId, predicate) {
  return await waitFor(async () => {
    const record = JSON.parse(
      await fs.readFile(path.join(jobsDir(workspaceRoot), `${jobId}.json`), "utf8"),
    );
    return predicate(record) ? record : null;
  }, `job ${jobId} did not reach expected status`);
}

async function waitForNoBrokerFiles() {
  await waitFor(async () => {
    const entries = await fs.readdir(brokersDir(workspaceRoot)).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    return entries.filter((entry) => entry.endsWith(".json")).length === 0;
  }, "broker files were not cleaned up");
}

async function lineCount(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content.trim().split("\n").filter(Boolean).length;
}

async function waitForExit(child) {
  return await new Promise((resolve) => child.once("exit", resolve));
}

async function waitFor(fn, message, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const error = new Error(lastError ? `${message}: ${lastError.message}` : message);
  error.stdout = undefined;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
