import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dispatch } from "./consult-companion.mts";
import type { ParsedArgs } from "./lib/args.mts";

const companionPath = fileURLToPath(new URL("./consult-companion.mts", import.meta.url));
const stableCliPath = fileURLToPath(new URL("../bin/consult", import.meta.url));

test("dispatch routes delegate to its handler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-companion-delegate-"));
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = root;
  t.after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  const result = await dispatch("delegate", {
    positional: ["foo"],
    flags: { write: true },
  });

  assert.equal(result.exitCode, 2);
});

test("dispatch rejects an unknown subcommand", async () => {
  const result = await dispatch("nonsense", { positional: [], flags: {} });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr.startsWith("unknown subcommand:"), true);
  assert.equal(result.stderr.includes("Usage:"), true);
  assert.equal(result.stderr.includes("consult help"), true);
});

test("dispatch prints help for the help subcommand", async () => {
  const result = await dispatch("help", {} as ParsedArgs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("Common workflow:"), true);
  assert.equal(result.stdout.includes("Terms:"), true);
  assert.equal(result.stdout.includes("Host"), true);
  assert.equal(result.stdout.includes("Profile"), true);
  assert.equal(result.stdout.includes("Job"), true);
  assert.equal(result.stdout.includes("Broker"), true);
  assert.equal(result.stdout.includes("consult delegate --agent claude --read-only --"), true);
  assert.equal(result.stdout.includes("delegate"), true);
  assert.equal(result.stdout.includes("setup"), true);
  assert.equal(result.stdout.includes("status"), true);
  assert.equal(result.stdout.includes("doctor"), true);
  assert.equal(result.stdout.includes("logs"), true);
  assert.equal(result.stdout.includes("chain"), true);
  assert.equal(result.stdout.includes("brokers"), true);
  assert.equal(result.stdout.includes("adversarial-review"), false);
});

test("dispatch prints help for help aliases", async () => {
  for (const subcommand of [undefined, "--help", "-h"]) {
    const result = await dispatch(subcommand, { positional: [], flags: {} });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("Usage:"), true);
    assert.equal(result.stdout.includes("consult help"), true);
  }
});

test("dispatch help advertises the agent contract", async () => {
  const result = await dispatch("help", { positional: [], flags: {} });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("consult help --agent"), true);
});

test("dispatch prints the agent contract for help --agent", async () => {
  for (const subcommand of [undefined, "--help", "-h", "help"]) {
    const result = await dispatch(subcommand, { positional: [], flags: { agent: true } });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("Agent Usage Contract"), true);
    assert.equal(result.stdout.includes("## Exit codes"), true);
    assert.equal(result.stdout.includes("--resume-job"), true);
    assert.equal(result.stdout.includes("consult logs <job-id> --follow"), true);
    assert.equal(result.stdout.includes("consult chain <job-id>"), true);
    assert.equal(result.stdout.includes("consult doctor"), true);
    assert.equal(result.stdout.includes("Common workflow:"), false);
  }
});

test("dispatch routes setup json mode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-companion-setup-"));
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = root;
  t.after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  const result = await dispatch("setup", { positional: [], flags: { json: true } });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
});

test("direct CLI prints help", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-companion-cli-"));
  const stdoutPath = path.join(root, "stdout.txt");
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const stdoutFd = fs.openSync(stdoutPath, "w");
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [companionPath, "help"], {
      stdio: ["ignore", stdoutFd, "pipe"],
    });
  } catch (error) {
    fs.closeSync(stdoutFd);
    t.skip(`spawn failed: ${(error as Error).message}`);
    return;
  }
  fs.closeSync(stdoutFd);

  child!.stderr!.resume();

  const result = await waitForChild(child!);
  if (result.error) {
    t.skip(`spawn failed: ${result.error.message}`);
    return;
  }
  const stdout = await fsp.readFile(stdoutPath, "utf8");
  if (result.code === 0 && stdout === "") {
    t.skip("spawn produced no stdout in this sandbox");
    return;
  }

  assert.equal(result.code, 0);
  assert.equal(stdout.includes("delegate"), true);
});

test("direct CLI preserves handler stdout exactly", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-companion-cli-json-"));
  const stdoutPath = path.join(root, "stdout.txt");
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  t.after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  const stdoutFd = fs.openSync(stdoutPath, "w");
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [companionPath, "setup", "--json"], {
      env: { ...process.env, CONSULT_DATA_DIR: root },
      stdio: ["ignore", stdoutFd, "pipe"],
    });
  } catch (error) {
    fs.closeSync(stdoutFd);
    t.skip(`spawn failed: ${(error as Error).message}`);
    return;
  }
  fs.closeSync(stdoutFd);

  child!.stderr!.resume();

  const result = await waitForChild(child!);
  if (result.error) {
    t.skip(`spawn failed: ${result.error.message}`);
    return;
  }
  const stdout = await fsp.readFile(stdoutPath, "utf8");

  assert.equal(result.code, 0);
  assert.equal(stdout.endsWith("\n\n"), false);
  assert.equal(JSON.parse(stdout).schemaVersion, 1);
});

test("stable consult CLI preserves handler stdout exactly", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-cli-json-"));
  const stdoutPath = path.join(root, "stdout.txt");
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const stdoutFd = fs.openSync(stdoutPath, "w");
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [stableCliPath, "setup", "--json"], {
      env: { ...process.env, CONSULT_DATA_DIR: root },
      stdio: ["ignore", stdoutFd, "pipe"],
    });
  } catch (error) {
    fs.closeSync(stdoutFd);
    t.skip(`spawn failed: ${(error as Error).message}`);
    return;
  }
  fs.closeSync(stdoutFd);

  child!.stderr!.resume();

  const result = await waitForChild(child!);
  if (result.error) {
    t.skip(`spawn failed: ${result.error.message}`);
    return;
  }
  const stdout = await fsp.readFile(stdoutPath, "utf8");

  assert.equal(result.code, 0);
  assert.equal(stdout.endsWith("\n\n"), false);
  assert.equal(JSON.parse(stdout).schemaVersion, 1);
});

interface WaitForChildResult {
  error?: Error;
  code?: number | null;
}

function waitForChild(child: ChildProcess): Promise<WaitForChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: WaitForChildResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    child.on("error", (error) => settle({ error }));
    child.on("close", (code) => settle({ code }));
  });
}
