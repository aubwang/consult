import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { jobArtifactsDir } from "./broker-endpoint.mts";

const SESSION_STATE_SCHEMA_VERSION = 1;
const MAX_SESSION_STATE_BYTES = 32 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";

type ConfinedSessionProfile = "codex" | "claude";

interface SessionStateManifest {
  schemaVersion: 1;
  adapterVersion: string;
  profile: ConfinedSessionProfile;
  sessionId: string;
  cwd: string;
  files: Array<{
    archivePath: string;
    targetPath: string;
    bytes: number;
    sha256: string;
  }>;
}

export interface ConfinedSessionStateInput {
  workspaceRoot: string;
  jobId: string;
  profileRegistryId: string;
  sessionId: string;
  cwd: string;
}

export async function archiveConfinedSessionState(
  input: ConfinedSessionStateInput & { privateHome: string },
): Promise<void> {
  const profile = supportedProfile(input.profileRegistryId);
  const source = await findSessionTranscript(
    input.privateHome,
    profile,
    input.sessionId,
  );
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw sessionStateError("session transcript is not a regular file");
  }
  if (stat.size > MAX_SESSION_STATE_BYTES) {
    throw sessionStateError(
      `session transcript exceeds ${MAX_SESSION_STATE_BYTES} bytes`,
    );
  }

  const targetPath = safeRelativePath(input.privateHome, source);
  assertAllowedTarget(profile, targetPath, input.sessionId);
  const archiveRoot = jobArtifactsDir(input.workspaceRoot, input.jobId);
  const finalDir = path.join(archiveRoot, "session-state");
  const temporaryDir = path.join(
    archiveRoot,
    `.session-state.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  const archivePath = path.join("files", "0");
  const archivedFile = path.join(temporaryDir, archivePath);

  await fs.mkdir(path.dirname(archivedFile), { recursive: true, mode: 0o700 });
  try {
    await fs.copyFile(source, archivedFile, fs.constants.COPYFILE_EXCL);
    await fs.chmod(archivedFile, 0o600);
    const bytes = await fs.readFile(archivedFile);
    const manifest: SessionStateManifest = {
      schemaVersion: SESSION_STATE_SCHEMA_VERSION,
      adapterVersion: adapterVersion(profile),
      profile,
      sessionId: input.sessionId,
      cwd: path.resolve(input.cwd),
      files: [
        {
          archivePath,
          targetPath,
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      ],
    };
    await fs.writeFile(
      path.join(temporaryDir, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(temporaryDir, finalDir);
  } catch (error) {
    await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    throw error instanceof Error && error.name === "ConfinedSessionStateError"
      ? error
      : sessionStateError(error instanceof Error ? error.message : String(error));
  }
}

export async function validateConfinedSessionStateArchive(
  input: ConfinedSessionStateInput,
): Promise<void> {
  await readVerifiedArchive(input);
}

export async function restoreConfinedSessionState(
  input: ConfinedSessionStateInput & { privateHome: string },
): Promise<void> {
  const { manifest, archiveDir } = await readVerifiedArchive(input);
  for (const file of manifest.files) {
    const target = safeJoin(input.privateHome, file.targetPath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(archiveDir, file.archivePath), target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, 0o600);
  }
}

async function readVerifiedArchive(input: ConfinedSessionStateInput): Promise<{
  manifest: SessionStateManifest;
  archiveDir: string;
}> {
  const profile = supportedProfile(input.profileRegistryId);
  const archiveDir = path.join(jobArtifactsDir(input.workspaceRoot, input.jobId), "session-state");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(archiveDir, MANIFEST_NAME), "utf8"));
  } catch (error) {
    throw sessionStateError(
      `session archive is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isManifest(parsed)) {
    throw sessionStateError("session archive manifest is malformed");
  }
  if (
    parsed.profile !== profile ||
    parsed.adapterVersion !== adapterVersion(profile) ||
    parsed.sessionId !== input.sessionId ||
    parsed.cwd !== path.resolve(input.cwd)
  ) {
    throw sessionStateError("session archive does not match the requested Profile, Session, or cwd");
  }
  for (const file of parsed.files) {
    assertAllowedTarget(profile, file.targetPath, input.sessionId);
    const archivedFile = safeJoin(archiveDir, file.archivePath);
    const stat = await fs.lstat(archivedFile).catch((error) => {
      throw sessionStateError(error instanceof Error ? error.message : String(error));
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) {
      throw sessionStateError("session archive file metadata does not match its manifest");
    }
    const bytes = await fs.readFile(archivedFile);
    if (sha256(bytes) !== file.sha256) {
      throw sessionStateError("session archive file hash does not match its manifest");
    }
  }
  return { manifest: parsed, archiveDir };
}

async function findSessionTranscript(
  privateHome: string,
  profile: ConfinedSessionProfile,
  sessionId: string,
): Promise<string> {
  assertSafeSessionId(sessionId);
  const searchRoot = path.join(
    privateHome,
    profile === "codex" ? ".codex/sessions" : ".claude/projects",
  );
  const matches: string[] = [];
  await walkRegularFiles(searchRoot, (file) => {
    const basename = path.basename(file);
    if (
      (profile === "codex" && basename.endsWith(`-${sessionId}.jsonl`)) ||
      (profile === "claude" && basename === `${sessionId}.jsonl`)
    ) {
      matches.push(file);
    }
  });
  if (matches.length !== 1) {
    throw sessionStateError(
      `expected exactly one ${profile} transcript for Session '${sessionId}', found ${matches.length}`,
    );
  }
  return matches[0];
}

async function walkRegularFiles(
  directory: string,
  visit: (file: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkRegularFiles(candidate, visit);
    } else if (entry.isFile()) {
      visit(candidate);
    }
  }
}

function supportedProfile(profile: string): ConfinedSessionProfile {
  if (profile === "codex" || profile === "claude") return profile;
  throw sessionStateError(`confined resume is unsupported for Profile '${profile}'`);
}

function adapterVersion(profile: ConfinedSessionProfile): string {
  return profile === "codex" ? "codex-rollout-v1" : "claude-project-v1";
}

function assertAllowedTarget(
  profile: ConfinedSessionProfile,
  targetPath: string,
  sessionId: string,
): void {
  const normalized = targetPath.split(path.sep).join("/");
  const allowed =
    profile === "codex"
      ? normalized.startsWith(".codex/sessions/") &&
        normalized.endsWith(`-${sessionId}.jsonl`)
      : normalized.startsWith(".claude/projects/") &&
        normalized.endsWith(`/${sessionId}.jsonl`);
  if (!allowed) {
    throw sessionStateError("session archive contains a disallowed target path");
  }
  if (/\/(?:auth\.json|\.credentials\.json|\.claude\.json|history\.jsonl)$/u.test(normalized)) {
    throw sessionStateError("session archive attempted to include credential or shared history state");
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(sessionId)) {
    throw sessionStateError("Session id is unsafe for selective state archival");
  }
}

function safeRelativePath(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sessionStateError("session transcript resolves outside the private home");
  }
  return relative;
}

function safeJoin(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) {
    throw sessionStateError("session archive path must be relative");
  }
  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw sessionStateError("session archive path escapes its root");
  }
  return target;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isManifest(value: unknown): value is SessionStateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== SESSION_STATE_SCHEMA_VERSION ||
    typeof record.adapterVersion !== "string" ||
    (record.profile !== "codex" && record.profile !== "claude") ||
    typeof record.sessionId !== "string" ||
    typeof record.cwd !== "string" ||
    !Array.isArray(record.files) ||
    record.files.length !== 1
  ) {
    return false;
  }
  return record.files.every((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) return false;
    const entry = file as Record<string, unknown>;
    return (
      typeof entry.archivePath === "string" &&
      typeof entry.targetPath === "string" &&
      typeof entry.bytes === "number" &&
      Number.isSafeInteger(entry.bytes) &&
      entry.bytes >= 0 &&
      entry.bytes <= MAX_SESSION_STATE_BYTES &&
      typeof entry.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(entry.sha256)
    );
  });
}

function sessionStateError(message: string): Error {
  const error = new Error(`SESSION_STATE_ARCHIVE_FAILED: ${message}`);
  error.name = "ConfinedSessionStateError";
  return error;
}
