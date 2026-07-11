import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonWhenReady } from "./package-smoke-readiness.mts";

test("readJsonWhenReady waits for an existing coordination file to become complete JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "consult-json-ready-"));
  const file = path.join(root, "probe.json");
  try {
    await writeFile(file, "");
    const pending = readJsonWhenReady(file, { attempts: 20, delayMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(file, '{"ready":true}\n');

    assert.deepEqual(await pending, { ready: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
