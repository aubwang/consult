import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  pidIsAlive,
  processGroupIsAlive,
  terminateProcessGroup,
  terminateProcessTree,
  waitForTargetExit,
} from "./process.mts";

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

test("terminateProcessGroup kills a grandchild after its group leader exits", async (t) => {
  const pidPath = path.join(os.tmpdir(), `consult-grandchild-pid-${process.pid}-${Date.now()}`);
  t.after(() => fs.unlink(pidPath).catch(() => {}));
  const leader = await spawnNodeChild(
    t,
    `const { spawn } = require('node:child_process');
     const fs = require('node:fs');
     const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
     child.unref();
     fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
  );
  if (!leader) return;
  await waitForFile(pidPath);
  await waitForChildExit(leader);
  const grandchildPid = Number(await fs.readFile(pidPath, "utf8"));

  assert.equal(pidIsAlive(leader.pid), false);
  assert.equal(processGroupIsAlive(leader.pid), true);
  assert.equal(pidIsAlive(grandchildPid), true);

  await terminateProcessGroup(leader.pid);

  assert.equal(processGroupIsAlive(leader.pid), false);
  assert.equal(pidIsAlive(grandchildPid), false);
});

test("waitForTargetExit rejects when SIGKILL does not terminate the target", async () => {
  let now = 0;
  let forceKillCalls = 0;

  await assert.rejects(
    waitForTargetExit(
      () => true,
      () => {
        forceKillCalls += 1;
      },
      50,
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        forceKillGraceMs: 100,
      },
    ),
    /process target remained alive after SIGKILL/u,
  );
  assert.equal(forceKillCalls, 1);
  assert.equal(now, 150);
});

async function spawnNodeChild(
  t: TestContext,
  code: string,
): Promise<(ChildProcess & { pid: number }) | null> {
  let child: ChildProcess & { pid: number };
  try {
    child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: "ignore",
    }) as ChildProcess & { pid: number };
  } catch (error) {
    t.skip(`subprocess spawning unavailable: ${(error as Error).message}`);
    return null;
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", resolve);
  });
  if (spawnError) {
    t.skip(`subprocess spawning unavailable: ${spawnError.message}`);
    return null;
  }

  child.unref();
  t.after(() => {
    if (processGroupIsAlive(child.pid)) {
      process.kill(-child.pid, "SIGKILL");
    } else if (pidIsAlive(child.pid)) {
      process.kill(child.pid, "SIGKILL");
    }
  });
  return child;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
