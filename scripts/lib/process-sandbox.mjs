import fs from "node:fs";
import path from "node:path";

import {
  SANDBOX_HOME,
  profileHomeMounts,
  profileRuntimeMounts,
} from "./profile-launch-policy.mjs";

const SYSTEM_READ_ONLY_ROOTS = ["/usr", "/bin", "/lib", "/lib64"];
const SYSTEM_READ_ONLY_PATHS = [
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
];

export function normalizeAgentSandbox(value) {
  const normalized = String(value ?? "off").toLowerCase();
  if (normalized === "" || normalized === "0" || normalized === "false" || normalized === "off") {
    return "off";
  }
  if (normalized === "1" || normalized === "true" || normalized === "bwrap") {
    return "bwrap";
  }
  throw new Error(`unknown agent sandbox: ${value}`);
}

export function buildAgentLaunch({
  binary,
  args = [],
  cwd,
  env,
  workspaceRoot,
  mode,
  sandbox,
  profileRegistryId,
}) {
  const sandboxMode = normalizeAgentSandbox(sandbox);
  if (sandboxMode === "off") {
    return { binary, args, cwd, env };
  }
  if (sandboxMode !== "bwrap") {
    throw new Error(`unsupported agent sandbox: ${sandboxMode}`);
  }
  if (mode !== "write" && mode !== "read-only") {
    throw new Error(`unknown sandbox permission mode: ${mode}`);
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required for agent sandbox");
  }

  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const resolvedBinary = resolveExecutable(binary, env);
  const bwrapArgs = [
    "--die-with-parent",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "TMPDIR",
    SANDBOX_HOME,
  ];

  const binds = new Map();
  for (const root of SYSTEM_READ_ONLY_ROOTS) {
    addBind(binds, root, "ro");
  }
  for (const target of SYSTEM_READ_ONLY_PATHS) {
    addBind(binds, target, "ro");
  }
  for (const root of executableRoots(resolvedBinary)) {
    addBind(binds, root, "ro");
  }
  for (const mount of profileHomeMounts(profileRegistryId, env)) {
    addBind(binds, mount.source, "ro", mount.destination);
  }
  for (const mount of profileRuntimeMounts(profileRegistryId, env)) {
    addBind(binds, mount.source, "ro", mount.destination);
  }
  addBind(binds, realWorkspaceRoot, mode === "write" ? "rw" : "ro");

  for (const target of parentDirectories([...binds.keys(), cwd])) {
    bwrapArgs.push("--dir", target);
  }
  for (const [destination, bind] of binds) {
    bwrapArgs.push(
      bind.access === "rw" ? "--bind" : "--ro-bind",
      bind.source,
      destination,
    );
  }
  bwrapArgs.push("--chdir", cwd, resolvedBinary, ...args);

  return {
    binary: "bwrap",
    args: bwrapArgs,
    cwd,
    env: {
      ...env,
      HOME: SANDBOX_HOME,
      TMPDIR: SANDBOX_HOME,
    },
  };
}

function addBind(binds, sourcePath, access, destination = sourcePath) {
  if (!sourcePath || !destination || !fs.existsSync(sourcePath)) {
    return;
  }
  const realPath = fs.realpathSync(sourcePath);
  const previous = binds.get(destination);
  if (previous?.access === "rw" || previous?.access === access) {
    return;
  }
  binds.set(destination, { source: realPath, access });
}

function executableRoots(binary) {
  const roots = [];
  const linuxbrewIndex = binary.indexOf("/.linuxbrew/");
  if (linuxbrewIndex !== -1) {
    roots.push(binary.slice(0, linuxbrewIndex + "/.linuxbrew".length));
  }
  const nvmIndex = binary.indexOf("/.nvm/");
  if (nvmIndex !== -1) {
    roots.push(binary.slice(0, nvmIndex + "/.nvm".length));
  }
  if (roots.length === 0 && path.isAbsolute(binary)) {
    roots.push(path.dirname(binary));
  }
  return roots;
}

function resolveExecutable(binary, env) {
  if (path.isAbsolute(binary)) {
    return fs.realpathSync(binary);
  }
  for (const searchDir of String(env.PATH ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!searchDir) {
      continue;
    }
    const candidate = path.join(searchDir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return binary;
}

function parentDirectories(targets) {
  const dirs = new Set();
  for (const target of targets) {
    if (!path.isAbsolute(target)) {
      continue;
    }
    let current = path.dirname(target);
    const stack = [];
    while (current !== path.dirname(current)) {
      stack.push(current);
      current = path.dirname(current);
    }
    for (const dir of stack.reverse()) {
      dirs.add(dir);
    }
  }
  return dirs;
}
