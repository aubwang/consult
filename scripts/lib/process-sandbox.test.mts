import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { buildAgentLaunch, normalizeAgentSandbox } from "./process-sandbox.mts";

const roots: string[] = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-sandbox-"));
  roots.push(root);
  return fs.realpathSync(root);
}

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeAgentSandbox accepts off and bwrap aliases", () => {
  assert.equal(normalizeAgentSandbox(undefined), "off");
  assert.equal(normalizeAgentSandbox("off"), "off");
  assert.equal(normalizeAgentSandbox("0"), "off");
  assert.equal(normalizeAgentSandbox("bwrap"), "bwrap");
  assert.equal(normalizeAgentSandbox("1"), "bwrap");
  assert.throws(() => normalizeAgentSandbox("chroot"), /unknown agent sandbox/);
});

test("buildAgentLaunch leaves process launch unchanged when sandbox is off", () => {
  const launch = buildAgentLaunch({
    binary: "/bin/echo",
    args: ["hello"],
    cwd: "/tmp",
    env: { PATH: "/bin" },
    workspaceRoot: "/tmp",
    mode: "write",
    sandbox: "off",
  });

  assert.deepEqual(launch, {
    binary: "/bin/echo",
    args: ["hello"],
    cwd: "/tmp",
    env: { PATH: "/bin" },
  });
});

test("buildAgentLaunch mounts workspace read-only for read-only jobs", () => {
  const workspaceRoot = makeRoot();
  const launch = buildAgentLaunch({
    binary: process.execPath,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH },
    workspaceRoot,
    mode: "read-only",
    sandbox: "bwrap",
  });

  assert.equal(launch.binary, "bwrap");
  assert.equal(launch.cwd, workspaceRoot);
  assert.equal(launch.env.HOME, "/tmp");
  assert.equal(launch.env.TMPDIR, "/tmp");
  assert.ok(hasTriple(launch.args, "--ro-bind", workspaceRoot, workspaceRoot));
  assert.equal(hasTriple(launch.args, "--bind", workspaceRoot, workspaceRoot), false);
  assert.deepEqual(launch.args.slice(-2), [fs.realpathSync(process.execPath), "--version"]);
});

test("buildAgentLaunch mounts workspace writable for write jobs", () => {
  const workspaceRoot = makeRoot();
  const launch = buildAgentLaunch({
    binary: process.execPath,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH },
    workspaceRoot,
    mode: "write",
    sandbox: "bwrap",
  });

  assert.ok(hasTriple(launch.args, "--bind", workspaceRoot, workspaceRoot));
  assert.equal(hasTriple(launch.args, "--ro-bind", workspaceRoot, workspaceRoot), false);
});

test("buildAgentLaunch mounts profile auth config into the sandbox home", () => {
  const workspaceRoot = makeRoot();
  const hostHome = makeRoot();
  const claudeDir = path.join(hostHome, ".claude");
  const codexDir = path.join(hostHome, ".codex");
  fs.mkdirSync(claudeDir);
  fs.mkdirSync(codexDir);
  const codexAuth = path.join(codexDir, "auth.json");
  const codexConfig = path.join(codexDir, "config.toml");
  fs.writeFileSync(codexAuth, "{}");
  fs.writeFileSync(codexConfig, "model = \"test\"\n");

  const claudeLaunch = buildAgentLaunch({
    binary: process.execPath,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH, HOME: hostHome },
    workspaceRoot,
    mode: "read-only",
    sandbox: "bwrap",
    profileRegistryId: "claude",
  });
  const codexLaunch = buildAgentLaunch({
    binary: process.execPath,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH, HOME: hostHome },
    workspaceRoot,
    mode: "read-only",
    sandbox: "bwrap",
    profileRegistryId: "codex",
  });
  assert.ok(hasTriple(claudeLaunch.args, "--ro-bind", fs.realpathSync(claudeDir), "/tmp/.claude"));
  assert.equal(claudeLaunch.env.HOME, "/tmp");
  assert.ok(
    hasTriple(codexLaunch.args, "--ro-bind", fs.realpathSync(codexAuth), "/tmp/.codex/auth.json"),
  );
  assert.ok(
    hasTriple(
      codexLaunch.args,
      "--ro-bind",
      fs.realpathSync(codexConfig),
      "/tmp/.codex/config.toml",
    ),
  );
  assert.equal(hasTriple(codexLaunch.args, "--ro-bind", fs.realpathSync(codexDir), "/tmp/.codex"), false);
  assert.equal(codexLaunch.env.HOME, "/tmp");
});

test("buildAgentLaunch does not add profile-specific opencode runtime mounts", () => {
  const workspaceRoot = makeRoot();
  const runtimeDir = makeRoot();
  const daemonPid = path.join(runtimeDir, "op-daemon.pid");
  fs.writeFileSync(daemonPid, "123");

  const launch = buildAgentLaunch({
    binary: process.execPath,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: runtimeDir },
    workspaceRoot,
    mode: "read-only",
    sandbox: "bwrap",
    profileRegistryId: "opencode",
  });

  assert.equal(hasTriple(launch.args, "--ro-bind", fs.realpathSync(daemonPid), daemonPid), false);
});

test("buildAgentLaunch detects Linuxbrew roots without a host-specific prefix", () => {
  const workspaceRoot = makeRoot();
  const brewRoot = path.join(makeRoot(), ".linuxbrew");
  const binDir = path.join(brewRoot, "bin");
  const binary = path.join(binDir, "fake-agent");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\n");
  fs.chmodSync(binary, 0o755);

  const launch = buildAgentLaunch({
    binary,
    args: ["--version"],
    cwd: workspaceRoot,
    env: { PATH: binDir },
    workspaceRoot,
    mode: "read-only",
    sandbox: "bwrap",
  });

  assert.ok(hasTriple(launch.args, "--ro-bind", fs.realpathSync(brewRoot), brewRoot));
});

test("buildAgentLaunch requires a known permission mode under sandbox", () => {
  assert.throws(
    () =>
      buildAgentLaunch({
        binary: process.execPath,
        cwd: "/tmp",
        env: {},
        workspaceRoot: "/tmp",
        mode: "supervised",
        sandbox: "bwrap",
      }),
    /unknown sandbox permission mode/,
  );
});

test(
  "bwrap launch enforces a read-only workspace mount",
  { skip: !fs.existsSync("/usr/bin/bwrap") },
  () => {
    const workspaceRoot = makeRoot();
    const launch = buildAgentLaunch({
      binary: process.execPath,
      args: ["-e", "require('fs').writeFileSync('blocked.txt', 'nope')"],
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH },
      workspaceRoot,
      mode: "read-only",
      sandbox: "bwrap",
    });

    const result = spawnSync(launch.binary, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "blocked.txt")), false);
  },
);

test(
  "bwrap launch allows writes to the workspace in write mode",
  { skip: !fs.existsSync("/usr/bin/bwrap") },
  () => {
    const workspaceRoot = makeRoot();
    const launch = buildAgentLaunch({
      binary: process.execPath,
      args: ["-e", "require('fs').writeFileSync('allowed.txt', 'ok')"],
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH },
      workspaceRoot,
      mode: "write",
      sandbox: "bwrap",
    });

    const result = spawnSync(launch.binary, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, "allowed.txt"), "utf8"), "ok");
  },
);

test(
  "bwrap launch exposes profile config read-only under sandbox HOME",
  { skip: !fs.existsSync("/usr/bin/bwrap") },
  () => {
    const workspaceRoot = makeRoot();
    const hostHome = makeRoot();
    const claudeDir = path.join(hostHome, ".claude");
    const codexDir = path.join(hostHome, ".codex");
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(claudeDir, "token"), "ok-auth");
    fs.writeFileSync(path.join(codexDir, "auth.json"), "ok-codex-auth");
    const claudeLaunch = buildAgentLaunch({
      binary: process.execPath,
      args: [
        "-e",
        "process.stdout.write(require('fs').readFileSync(`${process.env.HOME}/.claude/token`, 'utf8'))",
      ],
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH, HOME: hostHome },
      workspaceRoot,
      mode: "read-only",
      sandbox: "bwrap",
      profileRegistryId: "claude",
    });
    const codexLaunch = buildAgentLaunch({
      binary: process.execPath,
      args: [
        "-e",
        "require('fs').writeFileSync(`${process.env.HOME}/.codex/runtime`, 'ok-runtime'); process.stdout.write(require('fs').readFileSync(`${process.env.HOME}/.codex/auth.json`, 'utf8'))",
      ],
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH, HOME: hostHome },
      workspaceRoot,
      mode: "read-only",
      sandbox: "bwrap",
      profileRegistryId: "codex",
    });
    const claudeResult = spawnSync(claudeLaunch.binary, claudeLaunch.args, {
      cwd: claudeLaunch.cwd,
      env: claudeLaunch.env,
      encoding: "utf8",
    });
    const codexResult = spawnSync(codexLaunch.binary, codexLaunch.args, {
      cwd: codexLaunch.cwd,
      env: codexLaunch.env,
      encoding: "utf8",
    });
    assert.equal(claudeResult.status, 0, claudeResult.stderr);
    assert.equal(claudeResult.stdout, "ok-auth");
    assert.equal(codexResult.status, 0, codexResult.stderr);
    assert.equal(codexResult.stdout, "ok-codex-auth");
  },
);

function hasTriple(values: string[], first: string, second: string, third: string): boolean {
  for (let index = 0; index < values.length - 2; index += 1) {
    if (values[index] === first && values[index + 1] === second && values[index + 2] === third) {
      return true;
    }
  }
  return false;
}
