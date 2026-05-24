import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const adapterPath = fileURLToPath(new URL("../../bin/consult-codex", import.meta.url));

test("consult-codex invokes the stable consult CLI with codex host identity", async (t) => {
  const fixture = await makeFakeConsult(t);

  const result = await execFileAsync(process.execPath, [adapterPath, "delegate", "fix it"], {
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CAPTURE_PATH: fixture.capturePath,
      CONSULT_HOST_SESSION_ID: "",
      CODEX_THREAD_ID: "",
    },
  });

  const capture = JSON.parse(await fs.readFile(fixture.capturePath, "utf8"));
  assert.equal(result.stdout, "fake consult stdout\n");
  assert.equal(result.stderr, "fake consult stderr\n");
  assert.deepEqual(capture.argv, ["delegate", "fix it"]);
  assert.equal(capture.host, "codex");
  assert.equal(capture.hostSessionId, "default");
});

test("consult-codex preserves an explicit codex host session id", async (t) => {
  const fixture = await makeFakeConsult(t);

  await execFileAsync(process.execPath, [adapterPath, "status", "job-1"], {
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CAPTURE_PATH: fixture.capturePath,
      CONSULT_HOST_SESSION_ID: "codex-session-1",
    },
  });

  const capture = JSON.parse(await fs.readFile(fixture.capturePath, "utf8"));
  assert.deepEqual(capture.argv, ["status", "job-1"]);
  assert.equal(capture.host, "codex");
  assert.equal(capture.hostSessionId, "codex-session-1");
});

test("consult-codex uses CODEX_THREAD_ID when no explicit host session id exists", async (t) => {
  const fixture = await makeFakeConsult(t);

  await execFileAsync(process.execPath, [adapterPath, "status"], {
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CAPTURE_PATH: fixture.capturePath,
      CONSULT_HOST_SESSION_ID: "",
      CODEX_THREAD_ID: "thread-1",
    },
  });

  const capture = JSON.parse(await fs.readFile(fixture.capturePath, "utf8"));
  assert.deepEqual(capture.argv, ["status"]);
  assert.equal(capture.host, "codex");
  assert.equal(capture.hostSessionId, "thread-1");
});

test("consult-codex does not import broker or state internals", async () => {
  const source = await fs.readFile(adapterPath, "utf8");

  assert.equal(source.includes("scripts/lib/state"), false);
  assert.equal(source.includes("scripts/lib/broker"), false);
  assert.equal(source.includes("consult-broker"), false);
});

async function makeFakeConsult(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-codex-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const binDir = path.join(root, "bin");
  const capturePath = path.join(root, "capture.json");
  const consultPath = path.join(binDir, "consult");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    consultPath,
    `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2),
  host: process.env.CONSULT_HOST,
  hostSessionId: process.env.CONSULT_HOST_SESSION_ID,
}));
process.stdout.write("fake consult stdout\\n");
process.stderr.write("fake consult stderr\\n");
`,
    { mode: 0o755 },
  );

  return { binDir, capturePath };
}
