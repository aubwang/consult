import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { startAgent as defaultStartAgent } from "./acp-client.mts";
import { copilotAgentVersionDiagnostic } from "./profile-launch-policy.mts";
import { dataDir as defaultDataDir } from "./broker-endpoint.mts";
import { probeBinaryOnPath } from "./setup-probe.mts";

export type InstallStage = "install" | "discover" | "smoke" | "codex-runtime";

export interface InstallCaptured {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface InstallFailure {
  ok: false;
  stage: InstallStage;
  message: string;
  captured?: InstallCaptured;
}

export interface InstalledProfile {
  registryId: string;
  binary: string;
  args: string[];
  env: Record<string, string>;
  installedAt: string;
  installedVia: string;
  lastVerifiedAt: string;
  /**
   * Absolute path to the Codex CLI the adapter must run, present only when the
   * adapter cannot resolve a bundled Codex itself (ADR-0036).
   */
  codexPath?: string;
  /** Version reported by `<codexPath> --version` at setup, for diagnostics. */
  codexVersion?: string;
}

export interface InstallSuccess {
  ok: true;
  profile: InstalledProfile;
}

export type InstallResult = InstallSuccess | InstallFailure;

export interface RegistryInstallSpec {
  type: string;
  cmd?: string;
  repo?: string;
  version?: string;
  assetTemplate?: string;
  binaryInArchive?: string;
}

export interface InstallRegistryEntry {
  id: string;
  binary: string;
  args: string[];
  install: RegistryInstallSpec;
}

export interface ReleaseTarget {
  triple: string;
  archiveFormat: string;
}

export interface FetchAssetDigestParams {
  repo: string;
  version: string;
  assetName: string;
}

export interface DownloadAndExtractParams {
  url: string;
  installRoot: string;
  archiveFormat: string;
  expectedDigest: string;
}

export interface SpawnInstallResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface InstallSmokeAgent {
  capabilities?: unknown;
  dispose: () => Promise<void>;
}

export interface InstallDeps {
  startAgent?: (params: {
    binary: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    clientHandlers: Record<string, never>;
    initTimeoutMs: number;
    codexPath?: string;
  }) => Promise<InstallSmokeAgent>;
  spawnInstall?: (command: string) => Promise<SpawnInstallResult>;
  whichBinary?: (binary: string) => Promise<string | null> | string | null;
  now?: () => string;
  detectTarget?: () => ReleaseTarget | null;
  dataDir?: () => string;
  fetchAssetDigest?: (params: FetchAssetDigestParams) => Promise<string>;
  downloadAndExtract?: (params: DownloadAndExtractParams) => Promise<void>;
  /**
   * Mirrors codex-acp's own bundled-Codex resolution from the adapter binary's
   * real path. Returns the resolved `@openai/codex/bin/codex.js`, or null when
   * the adapter has no npm tree to resolve it through.
   */
  resolveBundledCodex?: (adapterBinaryPath: string) => string | null;
  /** Real path of an executable candidate, or null when missing/not executable. */
  resolveCodexCandidate?: (candidate: string) => string | null;
  /** Runs `<candidate> --version` under a bounded timeout. */
  probeCodexVersion?: (candidate: string) => Promise<SpawnInstallResult>;
  homeDir?: () => string;
}

export interface InstallAndVerifyOptions {
  registryEntry: InstallRegistryEntry;
  deps?: InstallDeps;
}

interface InstalledBinary {
  binaryPath: string;
}

interface GithubReleaseInstall {
  repo: string;
  version: string;
  assetTemplate: string;
  binaryInArchive?: string;
}

interface GithubReleaseAsset {
  name?: string;
  digest?: unknown;
}

export async function installAndVerify({
  registryEntry,
  deps = {},
}: InstallAndVerifyOptions): Promise<InstallResult> {
  let installed: InstalledBinary;
  try {
    installed = await performInstall(registryEntry, deps);
  } catch (error) {
    if (error instanceof InstallStageError) {
      return error.toResult();
    }
    throw error;
  }

  // The ACP handshake below cannot tell whether the codex adapter can actually
  // reach a Codex CLI: codex-acp spawns Codex lazily, so `initialize` succeeds
  // and the Profile only dies later, at session creation, inside a Job. Decide
  // reachability here so a dead Profile is never written to disk (ADR-0036).
  let codexRuntime: CodexRuntimePin | null = null;
  if (registryEntry.id === "codex") {
    try {
      codexRuntime = await resolveCodexRuntimePin(installed.binaryPath, deps);
    } catch (error) {
      if (error instanceof InstallStageError) {
        return error.toResult();
      }
      throw error;
    }
  }

  try {
    const agent = await (deps.startAgent ?? defaultStartAgent)({
      binary: installed.binaryPath,
      args: registryEntry.args,
      env: {},
      cwd: process.cwd(),
      clientHandlers: {},
      initTimeoutMs: 10000,
      ...(codexRuntime ? { codexPath: codexRuntime.codexPath } : {}),
    });
    // The handshake reports the agent's own identity and version; a Copilot
    // binary older than the supported floor would accept the launch pins
    // without honoring them, so it is refused before the Profile is recorded.
    const versionDiagnostic = copilotAgentVersionDiagnostic(
      registryEntry.id,
      agent.capabilities,
    );
    await agent.dispose();
    if (versionDiagnostic !== null) {
      return {
        ok: false,
        stage: "smoke",
        message: versionDiagnostic,
        captured: {},
      };
    }
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    return {
      ok: false,
      stage: "smoke",
      message: failure.message,
      captured: { stderr: failure.stderr },
    };
  }

  const now = deps.now ?? (() => new Date().toISOString());
  return {
    ok: true,
    profile: {
      registryId: registryEntry.id,
      binary: installed.binaryPath,
      args: registryEntry.args,
      env: {},
      installedAt: now(),
      installedVia: "registry",
      lastVerifiedAt: now(),
      ...(codexRuntime
        ? { codexPath: codexRuntime.codexPath, codexVersion: codexRuntime.codexVersion }
        : {}),
    },
  };
}

interface CodexRuntimePin {
  codexPath: string;
  codexVersion: string;
}

const CODEX_VERSION_PATTERN = /\d+\.\d+\.\d+/u;
const CODEX_VERSION_TIMEOUT_MS = 5000;

/**
 * Decide how the adopted codex-acp will reach a Codex CLI.
 *
 * Returns null when the adapter resolves its own bundled Codex — that install
 * needs no recorded pin, and adding one would freeze a path npm owns. Returns a
 * pin when an existing Codex CLI was detected and passed a version handshake.
 * Throws when neither holds: an adapter with no reachable Codex is a Profile
 * that fails at delegate time, so setup refuses it here instead.
 */
async function resolveCodexRuntimePin(
  adapterBinaryPath: string,
  deps: InstallDeps,
): Promise<CodexRuntimePin | null> {
  const bundled = (deps.resolveBundledCodex ?? defaultResolveBundledCodex)(adapterBinaryPath);
  if (bundled) {
    return null;
  }

  const rejected: string[] = [];
  let lastCaptured: InstallCaptured | undefined;
  for (const candidate of await codexCandidatePaths(deps)) {
    const resolved = (deps.resolveCodexCandidate ?? defaultResolveCodexCandidate)(candidate);
    if (!resolved) {
      rejected.push(`${candidate}: not an executable file`);
      continue;
    }
    let probe: SpawnInstallResult;
    try {
      probe = await (deps.probeCodexVersion ?? defaultProbeCodexVersion)(resolved);
    } catch (error) {
      rejected.push(`${resolved}: ${(error as Error).message}`);
      continue;
    }
    lastCaptured = probe;
    if (probe.exitCode !== 0) {
      rejected.push(`${resolved}: \`--version\` exited ${probe.exitCode}`);
      continue;
    }
    const version = CODEX_VERSION_PATTERN.exec(`${probe.stdout}\n${probe.stderr}`)?.[0];
    if (!version) {
      rejected.push(`${resolved}: \`--version\` printed no recognizable version`);
      continue;
    }
    return { codexPath: resolved, codexVersion: version };
  }

  throw new InstallStageError(
    "codex-runtime",
    codexUnreachableMessage(adapterBinaryPath, rejected),
    lastCaptured,
  );
}

function codexUnreachableMessage(adapterBinaryPath: string, rejected: string[]): string {
  const detail = rejected.length > 0 ? ` Rejected candidates: ${rejected.join("; ")}.` : "";
  return (
    `${adapterBinaryPath} cannot reach a Codex CLI: it resolves no bundled ` +
    "@openai/codex, and no usable `codex` binary was found on PATH or at " +
    `~/.local/bin/codex.${detail} Reinstall the adapter with its bundled Codex ` +
    "(`npm install -g @agentclientprotocol/codex-acp`), install `@openai/codex` " +
    "next to the adapter, or make a working `codex` binary available on PATH, " +
    "then rerun `consult setup --install codex`."
  );
}

async function codexCandidatePaths(deps: InstallDeps): Promise<string[]> {
  const candidates: string[] = [];
  const onPath = await probeBinaryOnPath("codex", deps);
  if (onPath.found && onPath.path) {
    candidates.push(onPath.path);
  }
  const home = (deps.homeDir ?? os.homedir)();
  if (home) {
    const local = path.join(home, ".local", "bin", "codex");
    if (!candidates.includes(local)) {
      candidates.push(local);
    }
  }
  return candidates;
}

/**
 * Resolve `@openai/codex/bin/codex.js` the way codex-acp itself does. npm global
 * bins are symlinks into the package tree, so resolution has to start from the
 * adapter's real location or it walks the wrong `node_modules` chain entirely
 * (the same lesson as ADR-0034).
 */
function defaultResolveBundledCodex(adapterBinaryPath: string): string | null {
  let realAdapterPath: string;
  try {
    realAdapterPath = realpathSync(adapterBinaryPath);
  } catch {
    return null;
  }
  try {
    return createRequire(realAdapterPath).resolve("@openai/codex/bin/codex.js");
  } catch {
    return null;
  }
}

function defaultResolveCodexCandidate(candidate: string): string | null {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function defaultProbeCodexVersion(candidate: string): Promise<SpawnInstallResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CODEX_VERSION_TIMEOUT_MS,
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
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

class InstallStageError extends Error {
  declare stage: InstallStage;
  declare captured?: InstallCaptured;
  constructor(stage: InstallStage, message: string, captured?: InstallCaptured) {
    super(message);
    this.stage = stage;
    this.captured = captured;
  }
  toResult(): InstallFailure {
    const result: InstallFailure = { ok: false, stage: this.stage, message: this.message };
    if (this.captured !== undefined) {
      result.captured = this.captured;
    }
    return result;
  }
}

async function performInstall(
  registryEntry: InstallRegistryEntry,
  deps: InstallDeps,
): Promise<InstalledBinary> {
  const type = registryEntry.install?.type;
  switch (type) {
    case "cargo":
    case "npm":
      return performShellInstall(registryEntry, deps);
    case "github-release":
      return performGithubReleaseInstall(registryEntry, deps);
    default:
      throw new InstallStageError("install", `unsupported install type: ${type}`);
  }
}

async function performShellInstall(
  registryEntry: InstallRegistryEntry,
  deps: InstallDeps,
): Promise<InstalledBinary> {
  const existing = await probeBinaryOnPath(registryEntry.binary, deps);
  if (existing.found) {
    return { binaryPath: existing.path };
  }

  let install: SpawnInstallResult;
  try {
    install = await (deps.spawnInstall ?? defaultSpawnInstall)(registryEntry.install.cmd as string);
  } catch (error) {
    const failure = error as Error & Partial<SpawnInstallResult>;
    throw new InstallStageError("install", failure.message, {
      stdout: failure.stdout,
      stderr: failure.stderr,
      exitCode: failure.exitCode,
    });
  }
  if (install.exitCode !== 0) {
    throw new InstallStageError("install", `install command exited ${install.exitCode}`, install);
  }
  const discovered = await probeBinaryOnPath(registryEntry.binary, deps);
  if (!discovered.found) {
    throw new InstallStageError(
      "discover",
      `binary ${registryEntry.binary} not found on PATH after install (search PATH or rerun shell init)`,
    );
  }
  return { binaryPath: discovered.path };
}

async function performGithubReleaseInstall(
  registryEntry: InstallRegistryEntry,
  deps: InstallDeps,
): Promise<InstalledBinary> {
  const { repo, version, assetTemplate, binaryInArchive } =
    registryEntry.install as GithubReleaseInstall;
  const detectTarget = deps.detectTarget ?? defaultDetectTarget;
  const target = detectTarget();
  if (!target) {
    throw new InstallStageError(
      "install",
      `no prebuilt asset mapping for ${process.platform}/${process.arch}`,
    );
  }
  const assetName = renderAssetName(assetTemplate, version, target);
  const url = `https://github.com/${repo}/releases/download/${version}/${assetName}`;
  const binaryName = binaryInArchive ?? registryEntry.binary;
  const installRoot = path.join((deps.dataDir ?? defaultDataDir)(), "bin", registryEntry.id);
  const binaryPath = path.join(installRoot, binaryName);
  if (!isWithinRoot(installRoot, binaryPath)) {
    throw new InstallStageError(
      "install",
      `binaryInArchive ${JSON.stringify(binaryName)} escapes the install root`,
    );
  }

  try {
    const stats = await fs.stat(binaryPath);
    if (stats.isFile()) {
      // Existing binary wins; if the user pinned a different version, they must remove it manually.
      return { binaryPath };
    }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== "ENOENT") {
      throw new InstallStageError(
        "discover",
        `failed to inspect existing binary target ${binaryPath}: ${failure.message}`,
      );
    }
  }

  let expectedDigest: string;
  try {
    expectedDigest = await (deps.fetchAssetDigest ?? defaultFetchAssetDigest)({
      repo,
      version,
      assetName,
    });
  } catch (error) {
    throw new InstallStageError(
      "install",
      `release metadata fetch failed for ${repo}@${version} (${assetName}): ${(error as Error).message}`,
    );
  }

  try {
    await (deps.downloadAndExtract ?? defaultDownloadAndExtract)({
      url,
      installRoot,
      archiveFormat: target.archiveFormat,
      expectedDigest,
    });
  } catch (error) {
    const failure = error as Error & { captured?: InstallCaptured };
    throw new InstallStageError("install", failure.message, failure.captured);
  }

  try {
    await fs.chmod(binaryPath, 0o755);
  } catch (error) {
    throw new InstallStageError(
      "discover",
      `binary ${binaryName} missing at ${binaryPath} after extract: ${(error as Error).message}`,
    );
  }

  return { binaryPath };
}

async function defaultFetchAssetDigest({
  repo,
  version,
  assetName,
}: FetchAssetDigestParams): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "consult-cli",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${apiUrl} -> HTTP ${response.status}`);
  }
  const release = (await response.json()) as { assets?: GithubReleaseAsset[] };
  const asset = release.assets?.find((entry) => entry.name === assetName);
  if (!asset) {
    throw new Error(`asset ${assetName} not present in release ${version}`);
  }
  if (typeof asset.digest !== "string" || !asset.digest.startsWith("sha256:")) {
    throw new Error(
      `asset ${assetName} has no sha256 digest in release metadata; refusing to install unverified binary`,
    );
  }
  return asset.digest;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

function renderAssetName(template: string, version: string, target: ReleaseTarget): string {
  const versionNoV = version.startsWith("v") ? version.slice(1) : version;
  return template
    .replaceAll("{version}", version)
    .replaceAll("{versionNoV}", versionNoV)
    .replaceAll("{target}", target.triple)
    .replaceAll("{ext}", target.archiveFormat);
}

const TARGET_MAP: Record<string, ReleaseTarget> = {
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", archiveFormat: "tar.gz" },
  "darwin-x64": { triple: "x86_64-apple-darwin", archiveFormat: "tar.gz" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", archiveFormat: "tar.gz" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", archiveFormat: "zip" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", archiveFormat: "zip" },
};

function defaultDetectTarget(): ReleaseTarget | null {
  return TARGET_MAP[`${process.platform}-${process.arch}`] ?? null;
}

async function defaultDownloadAndExtract({
  url,
  installRoot,
  archiveFormat,
  expectedDigest,
}: DownloadAndExtractParams): Promise<void> {
  await fs.rm(installRoot, { recursive: true, force: true });
  await fs.mkdir(installRoot, { recursive: true });
  const archivePath = path.join(installRoot, `.download.${archiveFormat}`);
  try {
    await runCommand(["curl", "-fsSL", "--retry", "2", "-o", archivePath, url]);
    if (expectedDigest) {
      const actualDigest = await sha256File(archivePath);
      if (actualDigest !== expectedDigest) {
        throw new Error(
          `sha256 mismatch on downloaded asset: expected ${expectedDigest}, got ${actualDigest}`,
        );
      }
    }
    await assertSafeArchive(archivePath, archiveFormat);
    if (archiveFormat === "tar.gz") {
      await runCommand(["tar", "-xzf", archivePath, "-C", installRoot]);
    } else if (archiveFormat === "zip") {
      await runCommand(["unzip", "-q", "-o", archivePath, "-d", installRoot]);
    } else {
      throw new Error(`unsupported archive format: ${archiveFormat}`);
    }
  } finally {
    await fs.unlink(archivePath).catch(() => {});
  }
}

// Defends the extraction step against malicious archives: an entry with an
// absolute path or a `..` component can write outside `installRoot` (Zip Slip),
// and a symlink/hardlink member can redirect a later write through the link.
// We refuse to unpack such archives rather than trust `tar`/`unzip` defaults,
// which vary across GNU tar, bsdtar, and Info-ZIP.
export async function assertSafeArchive(archivePath: string, archiveFormat: string): Promise<void> {
  const { names, verbose } = await listArchiveMembers(archivePath, archiveFormat);
  for (const name of names) {
    if (isUnsafeMemberPath(name)) {
      throw new Error(`refusing to extract archive: unsafe member path ${JSON.stringify(name)}`);
    }
  }
  for (const line of verbose) {
    const type = memberTypeChar(line);
    if (type !== null && type !== "-" && type !== "d") {
      throw new Error(
        `refusing to extract archive: non-regular member (type '${type}') present; only files and directories are allowed`,
      );
    }
  }
}

async function listArchiveMembers(
  archivePath: string,
  archiveFormat: string,
): Promise<{ names: string[]; verbose: string[] }> {
  if (archiveFormat === "tar.gz") {
    const names = splitLines((await runCommand(["tar", "-tzf", archivePath])).stdout);
    const verbose = splitLines((await runCommand(["tar", "-tvzf", archivePath])).stdout);
    return { names, verbose };
  }
  if (archiveFormat === "zip") {
    const names = splitLines((await runCommand(["unzip", "-Z1", archivePath])).stdout);
    const verbose = splitLines((await runCommand(["unzip", "-Z", archivePath])).stdout);
    return { names, verbose };
  }
  throw new Error(`unsupported archive format: ${archiveFormat}`);
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

// True if the member name would resolve outside its extraction directory:
// absolute paths, Windows drive/UNC roots, or any `..` path segment.
export function isUnsafeMemberPath(name: string): boolean {
  const normalized = name.replaceAll("\\", "/").trim();
  if (normalized === "") return false;
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}

// Returns the type character from a `tar -tv`/`zipinfo` permission string
// (`-` file, `d` dir, `l` symlink, `h` hardlink, ...) or null for header,
// footer, and other lines that do not begin with a unix permission field.
function memberTypeChar(line: string): string | null {
  const match = /^([-dlhbcps])[-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]/.exec(line.trimStart());
  return match ? match[1] : null;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

function runCommand(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
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
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        const error: Error & { captured?: InstallCaptured } = new Error(
          `${argv[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
        );
        error.captured = { stdout, stderr, exitCode };
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultSpawnInstall(command: string): Promise<SpawnInstallResult> {
  const argv = parseInstallCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
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
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function parseInstallCommand(command: string): string[] {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) {
    throw new Error("install command is empty");
  }
  if (/[;&|<>$`\\]/.test(trimmed)) {
    throw new Error("install command contains unsupported shell syntax");
  }
  return trimmed.split(/\s+/);
}
