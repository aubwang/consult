import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "consult-package-"));

try {
  await run(process.execPath, ["scripts/build-package.mjs"]);
  const pack = await run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryRoot,
  ]);
  const [manifest] = JSON.parse(pack.stdout);
  assert.equal(manifest.name, "@aubwang/consult");

  const packagedFiles = new Set(manifest.files.map(({ path: filePath }) => filePath));
  for (const required of [
    "bin/consult",
    "dist/scripts/consult-broker.mjs",
    "dist/scripts/consult-companion.mjs",
    "dist/scripts/lib/registry.mjs",
    "dist/scripts/registry.json",
    "scripts/build-package.mjs",
  ]) {
    assert(packagedFiles.has(required), `package is missing ${required}`);
  }
  for (const filePath of packagedFiles) {
    assert(!filePath.endsWith(".mts"), `package includes TypeScript source ${filePath}`);
    assert(!filePath.includes(".test."), `package includes test file ${filePath}`);
    assert(!filePath.includes("/__fixtures__/"), `package includes fixture ${filePath}`);
    assert(!filePath.startsWith(".cruise/"), `package includes local state ${filePath}`);
    assert(!filePath.startsWith("hosts/claude-code/"), `package includes removed Host Adapter ${filePath}`);
  }

  const tarball = path.join(temporaryRoot, manifest.filename);
  const prefix = path.join(temporaryRoot, "prefix");
  await run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    tarball,
  ]);

  const binary = path.join(prefix, process.platform === "win32" ? "consult.cmd" : "bin/consult");
  await assertConsultHelp(binary);
  await assertInstalledBackgroundJob(binary, temporaryRoot);
  const npmGlobalModules = path.join(
    prefix,
    ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]),
  );
  await run(process.execPath, [
    path.join(
      npmGlobalModules,
      "@aubwang",
      "consult",
      "scripts",
      "build-package.mjs",
    ),
  ]);

  const bunHome = path.join(temporaryRoot, "bun");
  await run("bun", ["install", "--global", tarball], {
    env: { ...process.env, BUN_INSTALL: bunHome },
  });
  const bunBinary = path.join(
    bunHome,
    "bin",
    process.platform === "win32" ? "consult.exe" : "consult",
  );
  await assertConsultHelp(bunBinary);
  process.stdout.write(
    `package smoke passed (${manifest.filename}, ${manifest.files.length} files)\n`,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function assertConsultHelp(binary) {
  const help = await run(binary, ["help"], {
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });
  assert.match(help.stdout, /^Usage:\n  consult help/m);
}

async function assertInstalledBackgroundJob(binary, temporaryRoot) {
  const workspace = path.join(temporaryRoot, "background-workspace");
  const data = path.join(temporaryRoot, "background-data");
  await fs.mkdir(workspace);
  await fs.mkdir(data);
  await run("git", ["init"], { cwd: workspace });
  await fs.writeFile(
    path.join(data, "profiles.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      default: "broken-smoke-profile",
      profiles: {
        "broken-smoke-profile": {
          registryId: "broken-smoke-profile",
          binary: path.join(temporaryRoot, "intentionally-missing-agent"),
          args: [],
          env: {},
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })}\n`,
  );
  const env = {
    ...process.env,
    CONSULT_DATA_DIR: data,
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const delegated = await run(
    binary,
    [
      "delegate",
      "--agent",
      "broken-smoke-profile",
      "--read-only",
      "--background",
      "--json",
      "--",
      "package background smoke",
    ],
    { cwd: workspace, env },
  );
  const queued = JSON.parse(delegated.stdout);
  const jobId = queued?.job?.id;
  assert.equal(typeof jobId, "string", "background smoke did not return a Job id");

  let final = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await run(binary, ["status", jobId, "--json"], {
      cwd: workspace,
      env,
    });
    const parsed = JSON.parse(status.stdout);
    if (["completed", "cancelled", "failed"].includes(parsed?.job?.status)) {
      final = parsed;
      break;
    }
    await delay(100);
  }

  assert(final, "installed background worker did not finalize within 10 seconds");
  assert.equal(final.job.status, "failed");
  assert.doesNotMatch(
    final.outcome.errorMessage ?? "",
    /consult-(?:companion|broker)\.mts|MODULE_NOT_FOUND/,
    "installed background Job tried to launch a source-only .mts entrypoint",
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      ...options,
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
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}):\n${stderr || stdout}`,
        ),
      );
    });
  });
}
