import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { startAgent as defaultStartAgent } from "./acp-client.mjs";
import { dataDir as defaultDataDir } from "./broker-endpoint.mjs";
import { probeBinaryOnPath } from "./setup-probe.mjs";

export async function installAndVerify({ registryEntry, deps = {} }) {
  let installed;
  try {
    installed = await performInstall(registryEntry, deps);
  } catch (error) {
    if (error instanceof InstallStageError) {
      return error.toResult();
    }
    throw error;
  }

  try {
    const agent = await (deps.startAgent ?? defaultStartAgent)({
      binary: installed.binaryPath,
      args: registryEntry.args,
      env: {},
      cwd: process.cwd(),
      clientHandlers: {},
      initTimeoutMs: 10000,
    });
    await agent.dispose();
  } catch (error) {
    return {
      ok: false,
      stage: "smoke",
      message: error.message,
      captured: { stderr: error.stderr },
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
    },
  };
}

class InstallStageError extends Error {
  constructor(stage, message, captured) {
    super(message);
    this.stage = stage;
    this.captured = captured;
  }
  toResult() {
    const result = { ok: false, stage: this.stage, message: this.message };
    if (this.captured !== undefined) {
      result.captured = this.captured;
    }
    return result;
  }
}

async function performInstall(registryEntry, deps) {
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

async function performShellInstall(registryEntry, deps) {
  const existing = await probeBinaryOnPath(registryEntry.binary, deps);
  if (existing.found) {
    return { binaryPath: existing.path };
  }

  let install;
  try {
    install = await (deps.spawnInstall ?? defaultSpawnInstall)(registryEntry.install.cmd);
  } catch (error) {
    throw new InstallStageError("install", error.message, {
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
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

async function performGithubReleaseInstall(registryEntry, deps) {
  const { repo, version, assetTemplate, binaryInArchive } = registryEntry.install;
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

  try {
    const stats = await fs.stat(binaryPath);
    if (stats.isFile()) {
      // Existing binary wins; if the user pinned a different version, they must remove it manually.
      return { binaryPath };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new InstallStageError(
        "discover",
        `failed to inspect existing binary target ${binaryPath}: ${error.message}`,
      );
    }
  }

  let expectedDigest;
  try {
    expectedDigest = await (deps.fetchAssetDigest ?? defaultFetchAssetDigest)({
      repo,
      version,
      assetName,
    });
  } catch (error) {
    throw new InstallStageError(
      "install",
      `release metadata fetch failed for ${repo}@${version} (${assetName}): ${error.message}`,
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
    throw new InstallStageError("install", error.message, error.captured);
  }

  try {
    await fs.chmod(binaryPath, 0o755);
  } catch (error) {
    throw new InstallStageError(
      "discover",
      `binary ${binaryName} missing at ${binaryPath} after extract: ${error.message}`,
    );
  }

  return { binaryPath };
}

async function defaultFetchAssetDigest({ repo, version, assetName }) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "consult-plugin",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${apiUrl} -> HTTP ${response.status}`);
  }
  const release = await response.json();
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

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

function renderAssetName(template, version, target) {
  const versionNoV = version.startsWith("v") ? version.slice(1) : version;
  return template
    .replaceAll("{version}", version)
    .replaceAll("{versionNoV}", versionNoV)
    .replaceAll("{target}", target.triple)
    .replaceAll("{ext}", target.archiveFormat);
}

const TARGET_MAP = {
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", archiveFormat: "tar.gz" },
  "darwin-x64": { triple: "x86_64-apple-darwin", archiveFormat: "tar.gz" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", archiveFormat: "tar.gz" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", archiveFormat: "zip" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", archiveFormat: "zip" },
};

function defaultDetectTarget() {
  return TARGET_MAP[`${process.platform}-${process.arch}`] ?? null;
}

async function defaultDownloadAndExtract({ url, installRoot, archiveFormat, expectedDigest }) {
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

function runCommand(argv) {
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
        const error = new Error(`${argv[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
        error.captured = { stdout, stderr, exitCode };
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultSpawnInstall(command) {
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

export function parseInstallCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) {
    throw new Error("install command is empty");
  }
  if (/[;&|<>$`\\]/.test(trimmed)) {
    throw new Error("install command contains unsupported shell syntax");
  }
  return trimmed.split(/\s+/);
}
