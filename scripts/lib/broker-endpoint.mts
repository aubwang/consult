import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeSegment } from "./path-segments.mts";

const SOCKET_PATH_MAX_LENGTH = 100;
// Below this many identity chars, distinct host sessions could collide on one socket.
const MIN_SOCKET_IDENTITY_LENGTH = 8;
const SOCKET_LABEL_MAX_LENGTH = 12;

export interface BrokerIdentity {
  workspaceRoot: string;
  jobId?: string | null;
  host?: string | null;
  hostSessionId?: string | null;
  profile?: string | null;
}

export function workspaceHash(workspaceRoot: string): string {
  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  return crypto.createHash("sha256").update(realWorkspaceRoot).digest("hex");
}

export function dataDir(): string {
  return process.env.CONSULT_DATA_DIR ?? path.join(os.homedir(), ".consult");
}

export function workspaceDir(workspaceRoot: string): string {
  return path.join(dataDir(), "workspaces", workspaceHash(workspaceRoot));
}

export function brokerFilePath({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
}: BrokerIdentity): string {
  if (jobId) {
    return path.join(brokersDir(workspaceRoot), `${safeSegment(jobId)}.json`);
  }
  return path.join(
    brokersDir(workspaceRoot),
    `${safeSegment(host)}-${safeSegment(profile)}-${identityHash(host, hostSessionId)}.json`,
  );
}

export function jobsDir(workspaceRoot: string): string {
  return path.join(workspaceDir(workspaceRoot), "jobs");
}

export function logsDir(workspaceRoot: string): string {
  return path.join(workspaceDir(workspaceRoot), "logs");
}

export function brokersDir(workspaceRoot: string): string {
  return path.join(workspaceDir(workspaceRoot), "brokers");
}

export function brokerSocketPath({
  workspaceRoot,
  jobId,
  host,
  hostSessionId,
  profile,
}: BrokerIdentity): string {
  const hashPrefix = workspaceHash(workspaceRoot).slice(0, 12);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const candidates: Array<[string, string]> = [];
  const identity = jobId ? identityHash("job", jobId) : identityHash(host, hostSessionId);
  const prefixSegments = jobId
    ? ["job", safeSegment(jobId, { maxLength: SOCKET_LABEL_MAX_LENGTH })]
    : [
        safeSegment(host, { maxLength: SOCKET_LABEL_MAX_LENGTH }),
        safeSegment(profile, { maxLength: SOCKET_LABEL_MAX_LENGTH }),
      ];
  const prefix = `${hashPrefix}-${prefixSegments.join("-")}-`;
  if (runtimeDir && canCreateChildDirectory(runtimeDir)) {
    candidates.push([path.join(runtimeDir, "consult"), prefix]);
  }
  candidates.push([os.tmpdir(), `consult-${prefix}`]);

  for (const [basePath, filenamePrefix] of candidates) {
    const socketPath = socketPathWithinBudget(basePath, filenamePrefix, identity);
    if (socketPath !== null && socketPath.length <= SOCKET_PATH_MAX_LENGTH) {
      return socketPath;
    }
  }

  throw new Error(
    `broker socket path exceeds ${SOCKET_PATH_MAX_LENGTH} characters; set XDG_RUNTIME_DIR or TMPDIR to a shorter path`,
  );
}

function socketPathWithinBudget(basePath: string, filenamePrefix: string, identity: string): string | null {
  const suffix = ".sock";
  const availableIdLength =
    SOCKET_PATH_MAX_LENGTH -
    path.join(basePath, `${filenamePrefix}${suffix}`).length;
  if (availableIdLength < MIN_SOCKET_IDENTITY_LENGTH) {
    return null;
  }
  const socketIdentity = identity.slice(0, availableIdLength);

  return path.join(basePath, `${filenamePrefix}${socketIdentity}${suffix}`);
}

function canCreateChildDirectory(parentDir: string): boolean {
  try {
    fs.accessSync(parentDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function profilesPath(): string {
  return path.join(dataDir(), "profiles.json");
}

export function overrideFilePath(workspaceRoot: string): string {
  return path.join(workspaceDir(workspaceRoot), "override.json");
}

function identityHash(host: string | null | undefined, hostSessionId: string | null | undefined) {
  return crypto
    .createHash("sha256")
    .update(`${host ?? ""}\0${hostSessionId ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}
