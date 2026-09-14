import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInstalledConfinedDoctors,
  assertInstalledConfinedMatrix,
} from "./package-confinement-smoke.mjs";
import { removePackageTemporaryRoot } from "./package-smoke-cleanup.mts";

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
    "dist/scripts/consult-pi.mjs",
    "dist/scripts/consult-exec.mjs",
    "dist/scripts/lib/companion/batch.mjs",
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
    assert(
      !filePath.startsWith("scripts/package-confinement-"),
      `package includes repo-side confinement harness ${filePath}`,
    );
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
  await assertInstalledDiscovery(binary, temporaryRoot, "npm");
  await assertInstalledBackgroundJob(binary, temporaryRoot);
  await assertInstalledPiBatch(binary, temporaryRoot, "npm");
  if (process.env.CONSULT_PACKAGE_SMOKE_CONFINED === "1") {
    await assertInstalledConfinedMatrix(binary, temporaryRoot, "npm");
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
  await assertInstalledDiscovery(bunBinary, temporaryRoot, "bun");
  await assertInstalledPiBatch(bunBinary, temporaryRoot, "bun");
  if (process.env.CONSULT_PACKAGE_SMOKE_CONFINED === "1") {
    await assertInstalledConfinedDoctors(bunBinary, temporaryRoot, "bun");
  }
  process.stdout.write(
    `package smoke passed (${manifest.filename}, ${manifest.files.length} files)\n`,
  );
} finally {
  await removePackageTemporaryRoot(temporaryRoot);
}

async function assertInstalledPiBatch(binary, temporaryRoot, installer) {
  const workspace = path.join(temporaryRoot, `${installer}-pi-workspace`);
  const data = path.join(temporaryRoot, `${installer}-pi-data`);
  await fs.mkdir(workspace);
  await fs.mkdir(data);
  await run("git", ["init", "--quiet"], { cwd: workspace });
  const fakePi = path.join(workspace, "pi");
  await fs.writeFile(fakePi, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('0.84.4'); process.exit(0); }
let buffer='';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.stdin.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){
 const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
 let data;
 if(m.type==='get_state') data={model:{provider:'fixture',id:'fixture'},thinkingLevel:'off'};
 if(m.type==='get_available_models') data={models:[{provider:'fixture',id:'fixture'}]};
 if(m.type==='get_available_thinking_levels') data={levels:['off']};
 send({type:'response',id:m.id,command:m.type,success:true,data});
 if(m.type==='prompt') {
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'packed Pi completed'}});
  send({type:'message_end',message:{role:'assistant',stopReason:'stop'}});
  send({type:'agent_end'});send({type:'agent_settled'});
 }
}});
`, { mode: 0o755 });
  const env = { ...process.env, CONSULT_DATA_DIR: data, PATH: `${workspace}${path.delimiter}${process.env.PATH}` };
  await run(binary, ["setup", "--install", "pi"], { cwd: workspace, env });
  const tasks = path.join(workspace, "tasks.json");
  await fs.writeFile(tasks, JSON.stringify({ jobs: [{ label: "first", prompt: "First check" }, { label: "second", prompt: "Second check" }] }));
  const batch = JSON.parse((await run(binary, ["batch", tasks, "--agent", "pi", "--sandbox", "inherit", "--json"], { cwd: workspace, env })).stdout);
  assert.equal(batch.submitted, true);
  assert.equal(batch.jobIds.length, 2);
  const result = JSON.parse((await run(binary, ["wait", "--batch", batch.id, "--json", "--timeout", "10"], { cwd: workspace, env })).stdout);
  assert.deepEqual(result.jobs.map((job) => [job.job.status, job.outcome.finalText]), [["completed", "packed Pi completed"], ["completed", "packed Pi completed"]]);
}

async function assertInstalledDiscovery(binary, temporaryRoot, installer) {
  const workspace = path.join(temporaryRoot, `${installer}-discovery-workspace`);
  const data = path.join(temporaryRoot, `${installer}-discovery-data`);
  await fs.mkdir(workspace);
  await fs.mkdir(data);
  await run("git", ["init", "--quiet"], { cwd: workspace });
  const catalogue = path.join(workspace, "catalogue-agent");
  await fs.writeFile(catalogue, '#!/usr/bin/env node\nif (process.argv[2] !== "models") process.exit(2);\nconsole.log("example/model-1");\n', { mode: 0o700 });
  await fs.writeFile(path.join(data, "profiles.json"), JSON.stringify({
    schemaVersion: 1, default: null, profiles: {
      router: { registryId: "opencode", binary: catalogue, args: ["acp"], env: {}, installedAt: "2026-09-09" },
    },
  }));
  const options = { cwd: workspace, env: { ...process.env, CONSULT_DATA_DIR: data } };
  const capabilities = JSON.parse((await run(binary, ["capabilities", "--configured", "--json"], options)).stdout);
  assert.equal(capabilities.features.models, true);
  assert.equal(capabilities.configured.profiles[0].readiness, "unchecked");
  const report = JSON.parse((await run(binary, ["models", "--match", "model-1", "--json"], options)).stdout);
  assert.equal(report.complete, true);
  assert.equal(report.total, 1);
  assert.equal(report.models[0].model, "example/model-1");
  assert.equal(report.models[0].profile, "router");
  assert.equal(report.models[0].requiresExplicitInheritance, true);
  assert.equal(report.version, capabilities.version);
}

async function assertConsultHelp(binary) {
  const options = {
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  };
  const help = await run(binary, ["help"], options);
  assert.match(help.stdout, /^Usage:\n  consult <command> \[options\]/m);
  assert.match(help.stdout, /^Topics:$/mu);
  assert.doesNotMatch(help.stdout, /^Topic: /mu);

  const topic = await run(binary, ["help", "authority"], options);
  assert.match(topic.stdout, /^Topic: authority\n/u);

  const everything = await run(binary, ["help", "--all"], options);
  assert.match(everything.stdout, /^Topic: delegation$/mu);
  assert.match(everything.stdout, /## Exit codes/u);
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
