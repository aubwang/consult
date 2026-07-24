import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { jobArtifactsDir } from "./broker-endpoint.mts";

const SESSION_STATE_SCHEMA_VERSION = 1;
const MAX_SESSION_STATE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_STATE_FILES = 8;
const MANIFEST_NAME = "manifest.json";

type ConfinedSessionProfile = "codex" | "claude" | "grok";

/**
 * Grok stores one Session as a directory rather than a single transcript, so
 * Consult carries only the conversation state its own `session/load` needs.
 * `updates.jsonl` is the authoritative log; `chat_history.jsonl` is rebuilt
 * from it when absent. Rewind snapshots, feedback, and subagent trees are
 * deliberately excluded: they are large, are not needed to reopen a Session,
 * and would widen what a Job archive holds.
 */
const GROK_SESSION_STATE_FILES = Object.freeze([
  "updates.jsonl",
  "summary.json",
  "chat_history.jsonl",
  "plan.json",
  "signals.json",
]);
const GROK_REQUIRED_SESSION_STATE_FILE = "updates.jsonl";

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
  const sources = await findSessionStateFiles(
    input.privateHome,
    profile,
    input.sessionId,
  );
  const archiveRoot = jobArtifactsDir(input.workspaceRoot, input.jobId);
  const finalDir = path.join(archiveRoot, "session-state");
  const temporaryDir = path.join(
    archiveRoot,
    `.session-state.tmp-${process.pid}-${crypto.randomUUID()}`,
  );

  await fs.mkdir(path.join(temporaryDir, "files"), { recursive: true, mode: 0o700 });
  try {
    const files: SessionStateManifest["files"] = [];
    let totalBytes = 0;
    for (const [index, source] of sources.entries()) {
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw sessionStateError("session state source is not a regular file");
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_SESSION_STATE_BYTES) {
        throw sessionStateError(
          `session state exceeds ${MAX_SESSION_STATE_BYTES} bytes`,
        );
      }
      const targetPath = safeRelativePath(input.privateHome, source);
      assertAllowedTarget(profile, targetPath, input.sessionId);
      const archivePath = path.join("files", String(index));
      const archivedFile = path.join(temporaryDir, archivePath);
      await fs.copyFile(source, archivedFile, fs.constants.COPYFILE_EXCL);
      await fs.chmod(archivedFile, 0o600);
      const bytes = await fs.readFile(archivedFile);
      files.push({
        archivePath,
        targetPath,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
    const manifest: SessionStateManifest = {
      schemaVersion: SESSION_STATE_SCHEMA_VERSION,
      adapterVersion: adapterVersion(profile),
      profile,
      sessionId: input.sessionId,
      cwd: path.resolve(input.cwd),
      files,
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
  let totalBytes = 0;
  for (const file of parsed.files) {
    totalBytes += file.bytes;
    if (totalBytes > MAX_SESSION_STATE_BYTES) {
      throw sessionStateError(`session archive exceeds ${MAX_SESSION_STATE_BYTES} bytes`);
    }
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

async function findSessionStateFiles(
  privateHome: string,
  profile: ConfinedSessionProfile,
  sessionId: string,
): Promise<string[]> {
  assertSafeSessionId(sessionId);
  if (profile === "grok") {
    return await findGrokSessionStateFiles(privateHome, sessionId);
  }
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
  return matches;
}

// Grok writes `$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/<file>`. The
// group directory encodes the cwd, so Consult locates the Session directory by
// id rather than recomputing the vendor's encoding.
async function findGrokSessionStateFiles(
  privateHome: string,
  sessionId: string,
): Promise<string[]> {
  const searchRoot = path.join(privateHome, ".grok", "sessions");
  const groups = await fs.readdir(searchRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const sessionDirs: string[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = path.join(searchRoot, group.name, sessionId);
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat?.isDirectory()) sessionDirs.push(candidate);
  }
  if (sessionDirs.length !== 1) {
    throw sessionStateError(
      `expected exactly one grok Session directory for Session '${sessionId}', found ${sessionDirs.length}`,
    );
  }

  const sessionDir = sessionDirs[0];
  const files: string[] = [];
  for (const name of GROK_SESSION_STATE_FILES) {
    const candidate = path.join(sessionDir, name);
    const stat = await fs.lstat(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw sessionStateError(`grok session state '${name}' is not a regular file`);
    }
    files.push(candidate);
  }
  if (!files.some((file) => path.basename(file) === GROK_REQUIRED_SESSION_STATE_FILE)) {
    throw sessionStateError(
      `grok Session '${sessionId}' has no ${GROK_REQUIRED_SESSION_STATE_FILE} to archive`,
    );
  }
  return files;
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
  if (profile === "codex" || profile === "claude" || profile === "grok") return profile;
  throw sessionStateError(`confined resume is unsupported for Profile '${profile}'`);
}

const ADAPTER_VERSIONS: Readonly<Record<ConfinedSessionProfile, string>> = Object.freeze({
  codex: "codex-rollout-v1",
  claude: "claude-project-v1",
  grok: "grok-session-v1",
});

function adapterVersion(profile: ConfinedSessionProfile): string {
  return ADAPTER_VERSIONS[profile];
}

function assertAllowedTarget(
  profile: ConfinedSessionProfile,
  targetPath: string,
  sessionId: string,
): void {
  const normalized = targetPath.split(path.sep).join("/");
  const allowed = isAllowedTarget(profile, normalized, sessionId);
  if (!allowed) {
    throw sessionStateError("session archive contains a disallowed target path");
  }
  if (
    /\/(?:auth\.json|\.credentials\.json|\.claude\.json|mcp_credentials\.json|history\.jsonl)$/u
      .test(normalized)
  ) {
    throw sessionStateError("session archive attempted to include credential or shared history state");
  }
}

function isAllowedTarget(
  profile: ConfinedSessionProfile,
  normalized: string,
  sessionId: string,
): boolean {
  if (profile === "codex") {
    return (
      normalized.startsWith(".codex/sessions/") &&
      normalized.endsWith(`-${sessionId}.jsonl`)
    );
  }
  if (profile === "claude") {
    return (
      normalized.startsWith(".claude/projects/") &&
      normalized.endsWith(`/${sessionId}.jsonl`)
    );
  }
  // `.grok/sessions/<group>/<sessionId>/<allowlisted file>` exactly: one group
  // segment, then the Session id, then a known conversation-state file.
  const segments = normalized.split("/");
  return (
    segments.length === 5 &&
    segments[0] === ".grok" &&
    segments[1] === "sessions" &&
    segments[2] !== "" &&
    segments[2] !== "." &&
    segments[2] !== ".." &&
    segments[3] === sessionId &&
    GROK_SESSION_STATE_FILES.includes(segments[4])
  );
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
    (record.profile !== "codex" && record.profile !== "claude" && record.profile !== "grok") ||
    typeof record.sessionId !== "string" ||
    typeof record.cwd !== "string" ||
    !Array.isArray(record.files) ||
    record.files.length < 1 ||
    record.files.length > MAX_SESSION_STATE_FILES
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
