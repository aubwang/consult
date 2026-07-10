import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
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
  if (process.env.CONSULT_PACKAGE_SMOKE_CONFINED === "1") {
    await assertInstalledConfinedDoctor(binary, temporaryRoot, "npm");
  }
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
  if (process.env.CONSULT_PACKAGE_SMOKE_CONFINED === "1") {
    await assertInstalledConfinedDoctor(bunBinary, temporaryRoot, "bun");
  }
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
  const fakeAgent = path.join(workspace, "background-fake-acp.mjs");
  await fs.writeFile(
    fakeAgent,
    [
      'import readline from "node:readline";',
      "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of lines) {",
      "  const message = JSON.parse(line);",
      '  if (message.method === "initialize") {',
      "    process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\\n`);",
      '  } else if (message.method === "session/new") {',
      "    process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result: { sessionId: \"packed-background-session\" } })}\\n`);",
      '  } else if (message.method === "session/prompt") {',
      "    process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result: { stopReason: \"end_turn\" } })}\\n`);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(data, "profiles.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      default: "background-smoke-profile",
      profiles: {
        "background-smoke-profile": {
          registryId: "background-smoke-profile",
          binary: process.execPath,
          args: [fakeAgent],
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
      "background-smoke-profile",
      "--read-only",
      "--sandbox",
      "inherit",
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
  assert.equal(final.job.status, "completed");
  assert.equal(final.outcome.sessionId, "packed-background-session");
}

async function assertInstalledConfinedDoctor(binary, temporaryRoot, installer) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("packed confined smoke is supported only on native Linux or macOS");
  }
  const root = path.join(temporaryRoot, `confined-${installer}`);
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const fakeBin = path.join(root, "bin");
  const hostReadCanary = path.join(root, "host-read-canary.txt");
  const hostWriteCanary = path.join(root, "host-write-canary.txt");
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(data, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
    fs.mkdir(path.join(home, ".npm", "_logs"), { recursive: true }),
    fs.mkdir(path.join(home, ".claude", "debug"), { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await run("git", ["init"], { cwd: workspace });
  await fs.writeFile(hostReadCanary, "must remain unreadable\n", { mode: 0o600 });
  const sentinel = await startLoopbackSentinel();
  const fakeAgent = path.join(workspace, "packed-fake-acp.mjs");
  await fs.writeFile(
    fakeAgent,
    [
      'import readline from "node:readline";',
      'import fs from "node:fs/promises";',
      'import net from "node:net";',
      'const stagedAuth = await fs.readFile(`${process.env.CODEX_HOME}/auth.json`, "utf8");',
      'if (stagedAuth.trim() !== "{}") process.exit(44);',
      `try { await fs.readFile(${JSON.stringify(hostReadCanary)}); process.exit(41); } catch {}`,
      `try { await fs.writeFile(${JSON.stringify(hostWriteCanary)}, "sandbox-local"); } catch {}`,
      "const directLoopback = await new Promise((resolve) => {",
      `  const socket = net.connect({ host: "127.0.0.1", port: ${sentinel.port} });`,
      "  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);",
      '  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });',
      '  socket.once("error", () => { clearTimeout(timer); resolve(false); });',
      "});",
      "if (directLoopback) process.exit(43);",
      "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "for await (const line of lines) {",
      "  const message = JSON.parse(line);",
      '  if (message.method === "initialize") {',
      "    process.stdout.write(`${JSON.stringify({ jsonrpc: \"2.0\", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\\n`);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(
    path.join(data, "profiles.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      default: "packed-codex",
      profiles: {
        "packed-codex": {
          registryId: "codex",
          binary: process.execPath,
          args: [fakeAgent],
          env: { CODEX_HOME: codexHome },
          installedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })}\n`,
  );
  let result;
  try {
    result = await run(binary, ["doctor", "--agent", "packed-codex", "--json"], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CONSULT_DATA_DIR: data,
        PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });
  } finally {
    await sentinel.close();
  }
  const report = JSON.parse(result.stdout);
  assert.equal(report.authority?.confined?.ok, true);
  assert.equal(report.authority?.profileRegistryId, "codex");
  await assert.rejects(fs.access(hostWriteCanary));
}

async function startLoopbackSentinel() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    close: async () =>
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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
