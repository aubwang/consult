import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createJobLogCursor } from "./job-log-entries.mts";

test("log cursor reads new bytes once, carries partial UTF-8, and reports the original corrupt line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-cursor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "job.log");
  const cursor = createJobLogCursor(file);
  assert.deepEqual((await cursor.read()).entries, []);
  await fs.writeFile(file, '{"one":1}\n');
  assert.deepEqual((await cursor.read()).entries, [{ one: 1 }]);
  assert.deepEqual((await cursor.read()).entries, []);
  const next = Buffer.from('{"two":"é"}\n');
  const split = next.indexOf(0xc3) + 1;
  await fs.appendFile(file, next.subarray(0, split));
  assert.deepEqual((await cursor.read()).entries, []);
  await fs.appendFile(file, next.subarray(split));
  assert.deepEqual((await cursor.read()).entries, [{ two: "é" }]);
  await fs.appendFile(file, 'broken\n');
  await assert.rejects(cursor.read(), /job.log:3/);
});
