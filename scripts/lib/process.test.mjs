import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { pidIsAlive, terminateProcessTree } from "./process.mjs";

test("terminateProcessTree terminates a running child process", async (t) => {
  const child = await spawnNodeChild(t, "setInterval(() => {}, 1000)");
  if (!child) return;

  await terminateProcessTree(child.pid);

  assert.equal(pidIsAlive(child.pid), false);
});

test("terminateProcessTree resolves cleanly for a dead pid", async () => {
  await terminateProcessTree(999_999_999);
});

test("terminateProcessTree escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  const readyPath = path.join(os.tmpdir(), `consult-process-ready-${process.pid}-${Date.now()}`);
  t.after(() => fs.unlink(readyPath).catch(() => {}));
  const child = await spawnNodeChild(
    t,
    `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(
      readyPath,
    )}, 'ready'); setInterval(() => {}, 1000)`,
  );
  if (!child) return;
  await waitForFile(readyPath);

  const startedAt = Date.now();
  await terminateProcessTree(child.pid, { timeoutMs: 200 });

  assert.equal(pidIsAlive(child.pid), false);
  assert.ok(Date.now() - startedAt >= 150);
  assert.ok(Date.now() - startedAt < 500);
});

async function spawnNodeChild(t, code) {
  let child;
  try {
    child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    t.skip(`subprocess spawning unavailable: ${error.message}`);
    return null;
  }

  const spawnError = await new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", resolve);
  });
  if (spawnError) {
    t.skip(`subprocess spawning unavailable: ${spawnError.message}`);
    return null;
  }

  child.unref();
  t.after(() => {
    if (pidIsAlive(child.pid)) {
      process.kill(-child.pid, "SIGKILL");
    }
  });
  return child;
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
