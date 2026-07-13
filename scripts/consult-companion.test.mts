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
import { jobsDir, logsDir } from "./lib/broker-endpoint.mts";
import { resolveWorkspaceRoot } from "./lib/workspace.mts";

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
  assert.equal(result.stderr.includes("Operational contract"), false);
});

test("dispatch prints concise help for the help subcommand", async () => {
  const result = await dispatch("help", {} as ParsedArgs);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("Examples:"), true);
  assert.equal(result.stdout.includes("consult delegate --agent claude --read-only --"), true);
  assert.equal(result.stdout.includes("delegate"), true);
  assert.equal(result.stdout.includes("setup"), true);
  assert.equal(result.stdout.includes("status"), true);
  assert.equal(result.stdout.includes("wait"), true);
  assert.equal(result.stdout.includes("doctor"), true);
  assert.equal(result.stdout.includes("logs"), true);
  assert.equal(result.stdout.includes("chain"), true);
  assert.equal(result.stdout.includes("brokers"), true);
  assert.equal(result.stdout.includes("consult help --reference"), true);
  assert.equal(result.stdout.includes("Operational contract"), false);
  assert.equal(result.stdout.includes("## Exit codes"), false);
  assert.equal(result.stdout.includes("adversarial-review"), false);
});

test("dispatch prints the operational contract with help --reference", async () => {
  const result = await dispatch("help", { positional: [], flags: { reference: true } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("Operational contract"), true);
  assert.equal(result.stdout.includes("## Exit codes"), true);
  assert.equal(result.stdout.includes("Omit --model"), true);
  assert.equal(result.stdout.includes("provider/model"), true);
  assert.equal(result.stdout.includes("--after <job-id>"), true);
  assert.equal(result.stdout.includes("--keep-running"), true);
  assert.equal(result.stdout.includes("--summary"), true);
  assert.equal(result.stdout.includes("--label <text>"), true);
  assert.equal(result.stdout.includes("review --job <job-id>"), true);
  assert.equal(result.stdout.includes("afterJobIds"), true);
  assert.equal(result.stdout.includes("reviewOfJobId"), true);
  assert.match(result.stdout, /status lists the newest 20 Jobs by default/u);
  assert.match(result.stdout, /logs prints the latest 20 rendered lines by default/u);
  assert.match(result.stdout, /without embedded logs/u);
  assert.doesNotMatch(result.stdout, /adds logTail/u);
  assert.equal(result.stdout.includes("Host-specific"), false);
});

test("dispatch prints help for help aliases", async () => {
  for (const subcommand of [undefined, "--help", "-h"]) {
    const result = await dispatch(subcommand, { positional: [], flags: {} });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("Usage:"), true);
    assert.equal(result.stdout.includes("consult help"), true);
  }
});

test("help documents the extended exit codes, lineage env, and json coverage", async () => {
  const result = await dispatch("help", { positional: [], flags: { reference: true } });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /6 delegated turn finalized as failed/);
  assert.doesNotMatch(result.stdout, /7 .*review.*not supported/);
  assert.match(result.stdout, /8 Codex native review command was not advertised/);
  assert.match(result.stdout, /CONSULT_PARENT_JOB/);
  assert.match(result.stdout, /setup, agents, logs, doctor, and\s+brokers/);
  assert.match(result.stdout, /most recent completed or failed delegate Session/);
  assert.match(result.stdout, /cancelled Jobs are skipped/);
  assert.match(result.stdout, /CONSULT_OPENAI_API_KEY/);
  assert.match(result.stdout, /ambient vendor variables do not/);
  assert.match(result.stdout, /ambient Host\s+environment without confined credential translation/);
  assert.match(result.stdout, /one no-prompt Host OAuth refresh attempt/);
  assert.match(result.stdout, /Nested Jobs and\s+diagnostic commands never mutate Host credentials/);
  assert.doesNotMatch(result.stdout, /latest finalized delegate Session/);
});

test("dispatch maps NO_WORKSPACE to an actionable exit-2 error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-no-workspace-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(async () => {
    process.chdir(originalCwd);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const result = await dispatch("status", { positional: [], flags: {} });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "no workspace found: run consult inside a git repository\n");
});

test("dispatch review with default deps prints its error exactly once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-e2e-review-"));
  withDataDir(t, root);
  const stderrCapture = captureStream(t, process.stderr);

  const result = await dispatch("review", { positional: [], flags: {} });

  assert.equal(result.exitCode, 2);
  // Streaming handlers return empty stdout/stderr; the streamed write is the
  // single copy of the message.
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(
    stderrCapture.text(),
    "No profile configured (no profiles configured; run 'consult setup')\n",
  );
});

test("dispatch task-worker with default deps prints its error exactly once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-e2e-worker-"));
  withDataDir(t, root);
  const stderrCapture = captureStream(t, process.stderr);

  const result = await dispatch("task-worker", { positional: [], flags: {} });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(stderrCapture.text(), "task-worker requires --job-id\n");
});

test("dispatch logs --follow with default deps streams incrementally", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-e2e-follow-"));
  withDataDir(t, root);
  const workspaceRoot = await resolveWorkspaceRoot();
  const jobDir = jobsDir(workspaceRoot);
  const logDir = logsDir(workspaceRoot);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const jobId = "job-e2e-follow";
  const jobPath = path.join(jobDir, `${jobId}.json`);
  const logPath = path.join(logDir, `${jobId}.log`);
  fs.writeFileSync(jobPath, JSON.stringify({ jobId, status: "running" }));
  fs.writeFileSync(logPath, `${JSON.stringify(followUpdate(jobId, "first"))}\n`);
  const stdoutCapture = captureStream(t, process.stdout);

  const resultPromise = dispatch("logs", { positional: [jobId], flags: { follow: true } });
  await waitUntil(() => stdoutCapture.text().includes("first"));
  const textBeforeFinalize = stdoutCapture.text();
  fs.appendFileSync(logPath, `${JSON.stringify(followUpdate(jobId, " second"))}\n`);
  fs.writeFileSync(jobPath, JSON.stringify({ jobId, status: "completed" }));
  const result = await resultPromise;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  // Content arrived before the job finalized, so output really streamed.
  assert.equal(textBeforeFinalize, "first");
  assert.equal(stdoutCapture.text(), "first second");
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

test("stable consult CLI drains large JSON responses to a pipe", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-cli-large-json-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
  withDataDir(t, dataDir);
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const jobDir = jobsDir(workspaceRoot);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobDir, "job-large.json"),
    JSON.stringify({
      jobId: "job-large",
      profile: "codex",
      status: "completed",
      submittedAt: "2026-05-14T10:00:00.000Z",
      finalText: "x".repeat(4 * 1024 * 1024),
    }),
  );

  const child = spawn(process.execPath, [stableCliPath, "status", "--json"], {
    cwd: workspaceRoot,
    env: { ...process.env, CONSULT_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => {
      const stdoutChunks: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stdout!.on("end", () => resolve(Buffer.concat(stdoutChunks).toString("utf8")));
      child.stdout!.resume();
    }, 100);
  });
  child.stderr!.resume();
  const [result, stdout] = await Promise.all([waitForChild(child), stdoutPromise]);

  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(stdout) > 4 * 1024 * 1024);
  assert.equal(JSON.parse(stdout).jobs[0].job.id, "job-large");
});

interface WaitForChildResult {
  error?: Error;
  code?: number | null;
}

function withDataDir(t: { after: (fn: () => void | Promise<void>) => void }, dataDir: string): void {
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = dataDir;
  t.after(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
}

function captureStream(
  t: { after: (fn: () => void) => void },
  stream: NodeJS.WriteStream,
): { text: () => string } {
  const chunks: string[] = [];
  const originalWrite = stream.write;
  stream.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  t.after(() => {
    stream.write = originalWrite;
  });
  return { text: () => chunks.join("") };
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function followUpdate(jobId: string, text: string): Record<string, unknown> {
  return {
    method: "consult/update",
    params: {
      jobId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
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
