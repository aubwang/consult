import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH_MAX_LENGTH = 100;

export function workspaceHash(workspaceRoot) {
  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  return crypto.createHash("sha256").update(realWorkspaceRoot).digest("hex");
}

export function dataDir() {
  return process.env.CONSULT_DATA_DIR ?? path.join(os.homedir(), ".consult");
}

export function workspaceDir(workspaceRoot) {
  return path.join(dataDir(), "workspaces", workspaceHash(workspaceRoot));
}

export function brokerFilePath({ workspaceRoot, jobId, host, hostSessionId, profile }) {
  if (jobId) {
    return path.join(brokersDir(workspaceRoot), `${safeSegment(jobId)}.json`);
  }
  return path.join(
    brokersDir(workspaceRoot),
    `${safeSegment(host)}-${safeSegment(profile)}-${identityHash(host, hostSessionId)}.json`,
  );
}

export function jobsDir(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "jobs");
}

export function logsDir(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "logs");
}

export function brokersDir(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "brokers");
}

export function brokerSocketPath({ workspaceRoot, jobId, host, hostSessionId, profile }) {
  const hashPrefix = workspaceHash(workspaceRoot).slice(0, 12);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const candidates = [];
  const identity = jobId ? identityHash("job", jobId) : identityHash(host, hostSessionId);
  const prefixSegments = jobId
    ? ["job", safeSegment(jobId)]
    : [safeSegment(host), safeSegment(profile)];
  const prefix = `${hashPrefix}-${prefixSegments.join("-")}-`;
  if (runtimeDir && canCreateChildDirectory(runtimeDir)) {
    candidates.push([path.join(runtimeDir, "consult"), prefix]);
  }
  candidates.push([os.tmpdir(), `consult-${prefix}`]);

  for (const [basePath, filenamePrefix] of candidates) {
    const socketPath = socketPathWithinBudget(basePath, filenamePrefix, identity);
    if (socketPath.length <= SOCKET_PATH_MAX_LENGTH) {
      return socketPath;
    }
  }

  const [basePath, filenamePrefix] = candidates.at(-1);
  return socketPathWithinBudget(basePath, filenamePrefix, "");
}

function socketPathWithinBudget(basePath, filenamePrefix, identity) {
  const suffix = ".sock";
  const availableIdLength =
    SOCKET_PATH_MAX_LENGTH -
    path.join(basePath, `${filenamePrefix}${suffix}`).length;
  const socketIdentity = identity.slice(0, Math.max(0, availableIdLength));

  return path.join(basePath, `${filenamePrefix}${socketIdentity}${suffix}`);
}

function canCreateChildDirectory(parentDir) {
  try {
    fs.accessSync(parentDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function profilesPath() {
  return path.join(dataDir(), "profiles.json");
}

export function overrideFilePath(workspaceRoot) {
  return path.join(workspaceDir(workspaceRoot), "override.json");
}

function identityHash(host, hostSessionId) {
  return crypto
    .createHash("sha256")
    .update(`${host ?? ""}\0${hostSessionId ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function safeSegment(value) {
  return String(value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 40) || "unknown";
}
