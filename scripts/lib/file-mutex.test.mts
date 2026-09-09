import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { withFileMutex } from "./file-mutex.mts";

async function runChild(source: string, ...args: string[]): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}
const moduleUrl = new URL("./file-mutex.mts", import.meta.url).href;

test("file mutex serializes independent processes and recovers a crashed owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-mutex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "lock");
  const countFile = path.join(root, "count");
  await fs.writeFile(countFile, "0");
  await runChild(`
    import { withFileMutex } from ${JSON.stringify(moduleUrl)};
    await withFileMutex(process.argv[1], async () => { process.exit(0); });
  `, lock);
  await Promise.all(Array.from({ length: 4 }, () => runChild(`
    import fs from 'node:fs/promises';
    import { withFileMutex } from ${JSON.stringify(moduleUrl)};
    for (let i = 0; i < 20; i++) await withFileMutex(process.argv[1], async () => {
      const marker = process.argv[2] + '.exclusive';
      await fs.writeFile(marker, '', {flag: 'wx'});
      const value = Number(await fs.readFile(process.argv[2], 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 1));
      await fs.writeFile(process.argv[2], String(value + 1));
      await fs.unlink(marker);
    });
  `, lock, countFile)));
  assert.equal(await fs.readFile(countFile, "utf8"), "80");
  assert.deepEqual(await fs.readdir(lock), []);
});

test("file mutex timeout never evicts a live owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-mutex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await withFileMutex(root, async () => {
    await assert.rejects(withFileMutex(root, async () => assert.fail("lock was stolen"), 20), /Timed out/);
  });
  await withFileMutex(root, async () => {});
});
