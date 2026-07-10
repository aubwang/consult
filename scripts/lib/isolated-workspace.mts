import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { workspaceDir } from "./broker-endpoint.mts";
import { isRecord } from "./objects.mts";
import { atomicWriteJson } from "./state.mts";

export const ISOLATED_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ISOLATED_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PrepareIsolatedWorkspaceOptions {
  workspaceRoot: string;
  jobId: string;
  maxBufferBytes?: number;
  now?: () => string;
}

export interface SeededWorkspaceChanges {
  stagedPatchBytes: number;
  unstagedPatchBytes: number;
  untrackedFiles: string[];
}

export interface PreparedIsolatedWorkspace {
  schemaVersion: typeof ISOLATED_WORKSPACE_SCHEMA_VERSION;
  jobId: string;
  /** Original Workspace identity. Job records and Broker state remain keyed here. */
  workspaceRoot: string;
  /** Detached worktree path supplied to the delegated Profile as its cwd. */
  executionRoot: string;
  transactionRoot: string;
  artifactsDir: string;
  cleanupMetadataPath: string;
  headCommit: string;
  baselineTree: string;
  preparedAt: string;
  maxBufferBytes: number;
  seeded: SeededWorkspaceChanges;
}

export interface IsolatedTouchedFilesManifest {
  schemaVersion: typeof ISOLATED_WORKSPACE_SCHEMA_VERSION;
  jobId: string;
  workspaceRoot: string;
  baselineTree: string;
  files: string[];
}

export interface IsolatedCleanupMetadata {
  schemaVersion: typeof ISOLATED_WORKSPACE_SCHEMA_VERSION;
  jobId: string;
  workspaceRoot: string;
  executionRoot: string;
  status: "required" | "completed";
  preparedAt: string;
  finalizedAt?: string;
  cleanedAt?: string;
}

export interface FinalizedIsolatedWorkspace {
  schemaVersion: typeof ISOLATED_WORKSPACE_SCHEMA_VERSION;
  jobId: string;
  workspaceRoot: string;
  executionRoot: string;
  baselineTree: string;
  patchPath: string;
  patchBytes: number;
  touchedFilesPath: string;
  touchedFiles: string[];
  cleanupMetadataPath: string;
  finalizedAt: string;
}

export interface FinalizeIsolatedWorkspaceOptions {
  now?: () => string;
}

export interface CleanupIsolatedWorkspaceOptions {
  now?: () => string;
}

export async function prepareIsolatedWorkspace({
  workspaceRoot,
  jobId,
  maxBufferBytes = DEFAULT_ISOLATED_GIT_MAX_BUFFER_BYTES,
  now = defaultNow,
}: PrepareIsolatedWorkspaceOptions): Promise<PreparedIsolatedWorkspace> {
  validateJobId(jobId);
  validateMaxBuffer(maxBufferBytes);

  const originalRoot = await resolveGitWorkspaceRoot(workspaceRoot, maxBufferBytes);
  const transactionRoot = isolatedTransactionRoot(originalRoot, jobId);
  const executionRoot = path.join(transactionRoot, "worktree");
  const artifactsDir = path.join(transactionRoot, "artifacts");
  const cleanupMetadataPath = path.join(artifactsDir, "cleanup.json");
  const preparedAt = now();

  await fs.mkdir(path.dirname(transactionRoot), { recursive: true });
  try {
    await fs.mkdir(transactionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw isolatedWorkspaceError(
        "ISOLATED_WORKSPACE_EXISTS",
        `isolated workspace already exists for job '${jobId}'`,
      );
    }
    throw error;
  }
  await fs.mkdir(artifactsDir);

  try {
    const headCommit = await resolveHeadCommit(originalRoot, maxBufferBytes);
    const stagedPatch = (await runGit(originalRoot, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ], { maxBufferBytes })).stdout;
    const unstagedPatch = (await runGit(originalRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ], { maxBufferBytes })).stdout;
    const untrackedFiles = await listSafeUntrackedFiles(originalRoot, maxBufferBytes);

    await runGit(originalRoot, [
      "worktree",
      "add",
      "--detach",
      executionRoot,
      headCommit,
    ], { maxBufferBytes });

    await applySeedPatch(executionRoot, artifactsDir, "staged", stagedPatch, true, maxBufferBytes);
    await applySeedPatch(
      executionRoot,
      artifactsDir,
      "unstaged",
      unstagedPatch,
      false,
      maxBufferBytes,
    );
    for (const relativePath of untrackedFiles) {
      await copyUntrackedRegularFile(originalRoot, executionRoot, relativePath);
    }

    const baselineTree = await snapshotWorkspaceTree(
      executionRoot,
      artifactsDir,
      "baseline",
      maxBufferBytes,
    );
    const cleanup: IsolatedCleanupMetadata = {
      schemaVersion: ISOLATED_WORKSPACE_SCHEMA_VERSION,
      jobId,
      workspaceRoot: originalRoot,
      executionRoot,
      status: "required",
      preparedAt,
    };
    await atomicWriteJson(cleanupMetadataPath, cleanup);

    return {
      schemaVersion: ISOLATED_WORKSPACE_SCHEMA_VERSION,
      jobId,
      workspaceRoot: originalRoot,
      executionRoot,
      transactionRoot,
      artifactsDir,
      cleanupMetadataPath,
      headCommit,
      baselineTree,
      preparedAt,
      maxBufferBytes,
      seeded: {
        stagedPatchBytes: stagedPatch.byteLength,
        unstagedPatchBytes: unstagedPatch.byteLength,
        untrackedFiles,
      },
    };
  } catch (error) {
    await removeWorktree(originalRoot, executionRoot, maxBufferBytes).catch(() => {});
    await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function finalizeIsolatedWorkspace(
  prepared: PreparedIsolatedWorkspace,
  { now = defaultNow }: FinalizeIsolatedWorkspaceOptions = {},
): Promise<FinalizedIsolatedWorkspace> {
  await validatePreparedWorkspace(prepared);
  await listSafeUntrackedFiles(prepared.executionRoot, prepared.maxBufferBytes);

  const finalIndexPath = temporaryIndexPath(prepared.artifactsDir, "final");
  const indexEnv = gitIndexEnvironment(finalIndexPath);
  let patch: Buffer;
  let touchedFiles: string[];
  try {
    await runGit(prepared.executionRoot, ["read-tree", "HEAD"], {
      env: indexEnv,
      maxBufferBytes: prepared.maxBufferBytes,
    });
    await runGit(prepared.executionRoot, ["add", "--all", "--", "."], {
      env: indexEnv,
      maxBufferBytes: prepared.maxBufferBytes,
    });
    patch = (await runGit(prepared.executionRoot, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      prepared.baselineTree,
      "--",
    ], {
      env: indexEnv,
      maxBufferBytes: prepared.maxBufferBytes,
    })).stdout;
    const names = (await runGit(prepared.executionRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      prepared.baselineTree,
      "--",
    ], {
      env: indexEnv,
      maxBufferBytes: prepared.maxBufferBytes,
    })).stdout;
    touchedFiles = decodeNulPathList(names);
  } finally {
    await fs.rm(finalIndexPath, { force: true }).catch(() => {});
  }

  const patchPath = path.join(prepared.artifactsDir, "changes.patch");
  const touchedFilesPath = path.join(prepared.artifactsDir, "touched-files.json");
  const finalizedAt = now();
  const manifest: IsolatedTouchedFilesManifest = {
    schemaVersion: ISOLATED_WORKSPACE_SCHEMA_VERSION,
    jobId: prepared.jobId,
    workspaceRoot: prepared.workspaceRoot,
    baselineTree: prepared.baselineTree,
    files: touchedFiles,
  };
  await fs.writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
  await atomicWriteJson(touchedFilesPath, manifest);

  const cleanup = await readCleanupMetadata(prepared);
  await atomicWriteJson(prepared.cleanupMetadataPath, {
    ...cleanup,
    status: "required",
    finalizedAt,
  } satisfies IsolatedCleanupMetadata);

  return {
    schemaVersion: ISOLATED_WORKSPACE_SCHEMA_VERSION,
    jobId: prepared.jobId,
    workspaceRoot: prepared.workspaceRoot,
    executionRoot: prepared.executionRoot,
    baselineTree: prepared.baselineTree,
    patchPath,
    patchBytes: patch.byteLength,
    touchedFilesPath,
    touchedFiles,
    cleanupMetadataPath: prepared.cleanupMetadataPath,
    finalizedAt,
  };
}

export async function cleanupIsolatedWorkspace(
  prepared: PreparedIsolatedWorkspace,
  { now = defaultNow }: CleanupIsolatedWorkspaceOptions = {},
): Promise<IsolatedCleanupMetadata> {
  await validatePreparedPaths(prepared);
  const existing = await readCleanupMetadata(prepared);
  if (existing.status === "completed") {
    return existing;
  }

  await removeWorktree(prepared.workspaceRoot, prepared.executionRoot, prepared.maxBufferBytes);
  const completed: IsolatedCleanupMetadata = {
    ...existing,
    status: "completed",
    cleanedAt: now(),
  };
  await atomicWriteJson(prepared.cleanupMetadataPath, completed);
  return completed;
}

export function isolatedTransactionRoot(workspaceRoot: string, jobId: string): string {
  validateJobId(jobId);
  return path.join(workspaceDir(workspaceRoot), "isolated-jobs", jobId);
}

function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw isolatedWorkspaceError(
      "INVALID_JOB_ID",
      "job id must be 1-128 characters containing only letters, numbers, '.', '_', or '-'",
    );
  }
}

function validateMaxBuffer(maxBufferBytes: number): void {
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw isolatedWorkspaceError("INVALID_MAX_BUFFER", "maxBufferBytes must be a positive integer");
  }
}

async function resolveGitWorkspaceRoot(
  workspaceRoot: string,
  maxBufferBytes: number,
): Promise<string> {
  const realRoot = await fs.realpath(workspaceRoot);
  const gitRootText = (await runGit(realRoot, ["rev-parse", "--show-toplevel"], {
    maxBufferBytes,
  })).stdout.toString("utf8").trim();
  const gitRoot = await fs.realpath(gitRootText);
  if (gitRoot !== realRoot) {
    throw isolatedWorkspaceError(
      "WORKSPACE_NOT_GIT_ROOT",
      `workspace root must be the git top level: ${gitRoot}`,
    );
  }
  return realRoot;
}

async function resolveHeadCommit(
  workspaceRoot: string,
  maxBufferBytes: number,
): Promise<string> {
  try {
    return (await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"], {
      maxBufferBytes,
    })).stdout.toString("utf8").trim();
  } catch (error) {
    throw isolatedWorkspaceError(
      "ISOLATED_WORKSPACE_REQUIRES_COMMIT",
      "isolated write Jobs require a repository with at least one commit",
      error,
    );
  }
}

async function applySeedPatch(
  executionRoot: string,
  artifactsDir: string,
  label: string,
  patchBytes: Buffer,
  staged: boolean,
  maxBufferBytes: number,
): Promise<void> {
  if (patchBytes.byteLength === 0) {
    return;
  }
  const patchPath = path.join(artifactsDir, `.seed-${label}-${crypto.randomUUID()}.patch`);
  await fs.writeFile(patchPath, patchBytes, { flag: "wx", mode: 0o600 });
  try {
    await runGit(
      executionRoot,
      ["apply", "--binary", ...(staged ? ["--index"] : []), patchPath],
      { maxBufferBytes },
    );
  } finally {
    await fs.rm(patchPath, { force: true });
  }
}

async function snapshotWorkspaceTree(
  executionRoot: string,
  artifactsDir: string,
  label: string,
  maxBufferBytes: number,
): Promise<string> {
  const indexPath = temporaryIndexPath(artifactsDir, label);
  const env = gitIndexEnvironment(indexPath);
  try {
    await runGit(executionRoot, ["read-tree", "HEAD"], { env, maxBufferBytes });
    await runGit(executionRoot, ["add", "--all", "--", "."], { env, maxBufferBytes });
    return (await runGit(executionRoot, ["write-tree"], { env, maxBufferBytes })).stdout
      .toString("utf8")
      .trim();
  } finally {
    await fs.rm(indexPath, { force: true }).catch(() => {});
  }
}

function temporaryIndexPath(artifactsDir: string, label: string): string {
  return path.join(artifactsDir, `.${label}-index-${crypto.randomUUID()}`);
}

function gitIndexEnvironment(indexPath: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_INDEX_FILE: indexPath };
}

async function listSafeUntrackedFiles(
  workspaceRoot: string,
  maxBufferBytes: number,
): Promise<string[]> {
  const resolvedWorkspaceRoot = await fs.realpath(workspaceRoot);
  const output = (await runGit(workspaceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ], { maxBufferBytes })).stdout;
  const files = decodeNulPathList(output);
  for (const relativePath of files) {
    validateRelativeWorkspacePath(relativePath);
    const absolutePath = path.join(workspaceRoot, relativePath);
    const info = await fs.lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw isolatedWorkspaceError(
        "UNTRACKED_SYMLINK",
        `untracked symlink is not supported in isolated workspaces: ${relativePath}`,
      );
    }
    if (!info.isFile()) {
      throw isolatedWorkspaceError(
        "UNTRACKED_NON_REGULAR_FILE",
        `untracked path is not a regular file: ${relativePath}`,
      );
    }
    const resolved = await fs.realpath(absolutePath);
    if (!isLexicallyInside(resolved, resolvedWorkspaceRoot)) {
      throw isolatedWorkspaceError(
        "UNTRACKED_PATH_OUTSIDE_WORKSPACE",
        `untracked path resolves outside the workspace: ${relativePath}`,
      );
    }
  }
  return files;
}

function decodeNulPathList(output: Buffer): string[] {
  const files: string[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) {
      continue;
    }
    if (index > start) {
      const bytes = output.subarray(start, index);
      const decoded = bytes.toString("utf8");
      if (!Buffer.from(decoded, "utf8").equals(bytes)) {
        throw isolatedWorkspaceError(
          "UNSUPPORTED_PATH_ENCODING",
          "git returned a path that is not valid UTF-8",
        );
      }
      files.push(decoded);
    }
    start = index + 1;
  }
  return files;
}

function validateRelativeWorkspacePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw isolatedWorkspaceError(
      "UNSAFE_WORKSPACE_PATH",
      `unsafe workspace-relative path: ${relativePath}`,
    );
  }
}

async function copyUntrackedRegularFile(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): Promise<void> {
  validateRelativeWorkspacePath(relativePath);
  const sourcePath = path.join(sourceRoot, relativePath);
  const destinationPath = path.join(destinationRoot, relativePath);
  await ensureSafeDestinationParent(destinationRoot, path.dirname(relativePath));
  const info = await fs.lstat(sourcePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw isolatedWorkspaceError(
      "UNTRACKED_NON_REGULAR_FILE",
      `untracked path is not a regular file: ${relativePath}`,
    );
  }
  await fs.copyFile(sourcePath, destinationPath, fsConstants.constants.COPYFILE_EXCL);
  await fs.chmod(destinationPath, info.mode & 0o777);
}

async function ensureSafeDestinationParent(
  destinationRoot: string,
  relativeParent: string,
): Promise<void> {
  if (relativeParent === ".") {
    return;
  }
  validateRelativeWorkspacePath(relativeParent);
  let current = destinationRoot;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw isolatedWorkspaceError(
          "UNSAFE_DESTINATION_PATH",
          `destination parent is not a regular directory: ${relativeParent}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(current);
    }
  }
}

async function validatePreparedWorkspace(prepared: PreparedIsolatedWorkspace): Promise<void> {
  await validatePreparedPaths(prepared);
  const executionInfo = await fs.lstat(prepared.executionRoot);
  if (executionInfo.isSymbolicLink() || !executionInfo.isDirectory()) {
    throw isolatedWorkspaceError(
      "INVALID_ISOLATED_WORKSPACE",
      "isolated execution root is not a directory",
    );
  }
}

async function validatePreparedPaths(prepared: PreparedIsolatedWorkspace): Promise<void> {
  if (prepared.schemaVersion !== ISOLATED_WORKSPACE_SCHEMA_VERSION) {
    throw isolatedWorkspaceError("INVALID_ISOLATED_WORKSPACE", "unsupported isolated workspace schema");
  }
  validateJobId(prepared.jobId);
  validateMaxBuffer(prepared.maxBufferBytes);
  const originalRoot = await fs.realpath(prepared.workspaceRoot);
  const expectedTransactionRoot = isolatedTransactionRoot(originalRoot, prepared.jobId);
  const expectedExecutionRoot = path.join(expectedTransactionRoot, "worktree");
  const expectedArtifactsDir = path.join(expectedTransactionRoot, "artifacts");
  if (
    prepared.workspaceRoot !== originalRoot ||
    prepared.transactionRoot !== expectedTransactionRoot ||
    prepared.executionRoot !== expectedExecutionRoot ||
    prepared.artifactsDir !== expectedArtifactsDir ||
    prepared.cleanupMetadataPath !== path.join(expectedArtifactsDir, "cleanup.json")
  ) {
    throw isolatedWorkspaceError(
      "INVALID_ISOLATED_WORKSPACE",
      "isolated workspace paths do not match the original Workspace and job id",
    );
  }
  const transactionInfo = await fs.lstat(prepared.transactionRoot);
  const artifactsInfo = await fs.lstat(prepared.artifactsDir);
  if (
    transactionInfo.isSymbolicLink() ||
    !transactionInfo.isDirectory() ||
    artifactsInfo.isSymbolicLink() ||
    !artifactsInfo.isDirectory()
  ) {
    throw isolatedWorkspaceError(
      "INVALID_ISOLATED_WORKSPACE",
      "isolated workspace state directories are invalid",
    );
  }
}

async function readCleanupMetadata(
  prepared: PreparedIsolatedWorkspace,
): Promise<IsolatedCleanupMetadata> {
  const value: unknown = JSON.parse(await fs.readFile(prepared.cleanupMetadataPath, "utf8"));
  if (
    !isRecord(value) ||
    value.schemaVersion !== ISOLATED_WORKSPACE_SCHEMA_VERSION ||
    value.jobId !== prepared.jobId ||
    value.workspaceRoot !== prepared.workspaceRoot ||
    value.executionRoot !== prepared.executionRoot ||
    (value.status !== "required" && value.status !== "completed") ||
    typeof value.preparedAt !== "string"
  ) {
    throw isolatedWorkspaceError(
      "INVALID_CLEANUP_METADATA",
      "isolated workspace cleanup metadata is malformed",
    );
  }
  return value as unknown as IsolatedCleanupMetadata;
}

async function removeWorktree(
  workspaceRoot: string,
  executionRoot: string,
  maxBufferBytes: number,
): Promise<void> {
  try {
    const info = await fs.lstat(executionRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await fs.rm(executionRoot, { force: true });
      await runGit(workspaceRoot, ["worktree", "prune"], { maxBufferBytes });
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await runGit(workspaceRoot, ["worktree", "remove", "--force", executionRoot], {
      maxBufferBytes,
    });
  } catch {
    // A crashed process can leave the directory and Git's worktree registry out
    // of sync. The path has already been recomputed and confined to Consult state.
    await fs.rm(executionRoot, { recursive: true, force: true });
    await runGit(workspaceRoot, ["worktree", "prune"], { maxBufferBytes });
  }
}

function isLexicallyInside(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

interface RunGitOptions {
  env?: NodeJS.ProcessEnv;
  maxBufferBytes: number;
}

interface GitCommandOutput {
  stdout: Buffer;
  stderr: Buffer;
}

async function runGit(
  cwd: string,
  args: string[],
  { env = process.env, maxBufferBytes }: RunGitOptions,
): Promise<GitCommandOutput> {
  return await new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env,
        encoding: "buffer",
        maxBuffer: maxBufferBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
        };
        if (error) {
          const detail = output.stderr.toString("utf8").trim();
          reject(
            isolatedWorkspaceError(
              "GIT_COMMAND_FAILED",
              `git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`,
              error,
            ),
          );
          return;
        }
        resolve(output);
      },
    );
  });
}

export interface IsolatedWorkspaceError extends Error {
  code: string;
  cause?: unknown;
}

function isolatedWorkspaceError(
  code: string,
  message: string,
  cause?: unknown,
): IsolatedWorkspaceError {
  const error = new Error(message) as IsolatedWorkspaceError;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function defaultNow(): string {
  return new Date().toISOString();
}
