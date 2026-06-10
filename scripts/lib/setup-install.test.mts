import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { installAndVerify, parseInstallCommand } from "./setup-install.mts";
import type {
  DownloadAndExtractParams,
  InstallCaptured,
  InstallFailure,
  InstallSuccess,
} from "./setup-install.mts";

test("installAndVerify stops when the install command exits non-zero", async () => {
  const result = (await installAndVerify({
    registryEntry: registryEntryFixture(),
    deps: {
      spawnInstall: async () => ({
        stdout: "",
        stderr: "install failed",
        exitCode: 1,
      }),
      whichBinary: async () => null,
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.equal(result.message, "install command exited 1");
  assert.equal(result.captured!.stderr, "install failed");
});

test("installAndVerify skips shell install when the binary is already on PATH", async () => {
  let smokeBinary: string | null = null;

  const result = (await installAndVerify({
    registryEntry: registryEntryFixture({ args: ["acp"] }),
    deps: {
      spawnInstall: async () => {
        throw new Error("install should not run");
      },
      whichBinary: async () => "/manual/codex-acp",
      startAgent: async ({ binary }) => {
        smokeBinary = binary;
        return { dispose: async () => {} };
      },
      now: fixedClock(["2026-05-15T10:00:00.000Z", "2026-05-15T10:00:01.000Z"]),
    },
  })) as InstallSuccess;

  assert.equal(result.ok, true);
  assert.equal(smokeBinary, "/manual/codex-acp");
  assert.equal(result.profile.binary, "/manual/codex-acp");
  assert.equal(result.profile.lastVerifiedAt, "2026-05-15T10:00:01.000Z");
});

test("installAndVerify stops when discovery cannot find the binary", async () => {
  const result = (await installAndVerify({
    registryEntry: registryEntryFixture(),
    deps: {
      spawnInstall: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
      whichBinary: async () => null,
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "discover");
  assert.match(result.message, /binary codex-acp not found on PATH after install/);
});

test("installAndVerify stops when the smoke probe fails", async () => {
  const smokeError = Object.assign(new Error("agent failed to initialize"), {
    stderr: "auth missing",
  });

  const result = (await installAndVerify({
    registryEntry: registryEntryFixture(),
    deps: {
      spawnInstall: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
      whichBinary: async () => "/fake/codex-acp",
      startAgent: async () => {
        throw smokeError;
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "smoke");
  assert.equal(result.message, "agent failed to initialize");
  assert.deepEqual(result.captured, { stderr: "auth missing" });
});

test("installAndVerify returns a verified profile after install, discover, and smoke pass", async () => {
  let disposed = false;
  let installCalls = 0;
  let whichCalls = 0;

  const result = (await installAndVerify({
    registryEntry: registryEntryFixture({ args: ["acp"] }),
    deps: {
      spawnInstall: async () => {
        installCalls += 1;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      whichBinary: async () => {
        whichCalls += 1;
        return whichCalls === 1 ? null : "/fake/codex-acp";
      },
      startAgent: async (params) => {
        assert.deepEqual(params, {
          binary: "/fake/codex-acp",
          args: ["acp"],
          env: {},
          cwd: process.cwd(),
          clientHandlers: {},
          initTimeoutMs: 10000,
        });
        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
      now: fixedClock([
        "2026-05-15T10:00:00.000Z",
        "2026-05-15T10:00:01.000Z",
      ]),
    },
  })) as InstallSuccess;

  assert.equal(result.ok, true);
  assert.equal(installCalls, 1);
  assert.equal(disposed, true);
  assert.deepEqual(result.profile, {
    registryId: "codex",
    binary: "/fake/codex-acp",
    args: ["acp"],
    env: {},
    installedAt: "2026-05-15T10:00:00.000Z",
    installedVia: "registry",
    lastVerifiedAt: "2026-05-15T10:00:01.000Z",
  });
});

test("installAndVerify reports a spawn error as an install-stage failure", async () => {
  const result = (await installAndVerify({
    registryEntry: registryEntryFixture(),
    deps: {
      spawnInstall: async () => {
        throw new Error("spawn ENOENT");
      },
      whichBinary: async () => null,
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.equal(result.message, "spawn ENOENT");
});

test("parseInstallCommand parses registry install commands without a shell", () => {
  assert.deepEqual(parseInstallCommand("npm install -g @github/copilot"), [
    "npm",
    "install",
    "-g",
    "@github/copilot",
  ]);
  assert.throws(
    () => parseInstallCommand("npm install -g safe; curl https://example.invalid"),
    /unsupported shell syntax/,
  );
});

function registryEntryFixture(overrides = {}) {
  return {
    id: "codex",
    label: "Codex",
    binary: "codex-acp",
    args: [],
    install: { type: "cargo", cmd: "cargo install codex" },
    supports: { resume: true, load: true },
    ...overrides,
  };
}

function githubReleaseFixture(overrides = {}) {
  return {
    id: "codex",
    label: "Codex",
    binary: "codex-acp",
    args: [],
    install: {
      type: "github-release",
      repo: "zed-industries/codex-acp",
      version: "v0.14.0",
      assetTemplate: "codex-acp-{versionNoV}-{target}.{ext}",
      binaryInArchive: "codex-acp",
    },
    supports: { resume: true, load: true },
    ...overrides,
  };
}

test("installAndVerify github-release: downloads, extracts, and reports the absolute binary path", async (t) => {
  const tmpDataDir = await mkdtemp(path.join(os.tmpdir(), "consult-install-"));
  t.after(() => rm(tmpDataDir, { recursive: true, force: true }));

  const expectedBinary = path.join(tmpDataDir, "bin", "codex", "codex-acp");
  let downloadCalled = null as DownloadAndExtractParams | null;
  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => tmpDataDir,
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => "sha256:deadbeef",
      downloadAndExtract: async (params) => {
        downloadCalled = params;
        await mkdir(params.installRoot, { recursive: true });
        await writeFile(path.join(params.installRoot, "codex-acp"), "#!/bin/sh\nexit 0\n");
      },
      startAgent: async ({ binary }) => {
        assert.equal(binary, expectedBinary);
        return { dispose: async () => {} };
      },
      now: fixedClock(["2026-05-15T10:00:00.000Z", "2026-05-15T10:00:01.000Z"]),
    },
  })) as InstallSuccess;

  assert.equal(result.ok, true);
  assert.equal(result.profile.binary, expectedBinary);
  assert.equal(
    downloadCalled!.url,
    "https://github.com/zed-industries/codex-acp/releases/download/v0.14.0/codex-acp-0.14.0-x86_64-unknown-linux-gnu.tar.gz",
  );
  assert.equal(downloadCalled!.archiveFormat, "tar.gz");
  assert.equal(downloadCalled!.expectedDigest, "sha256:deadbeef");
});

test("installAndVerify github-release: skips download when the target binary already exists", async (t) => {
  const tmpDataDir = await mkdtemp(path.join(os.tmpdir(), "consult-install-"));
  t.after(() => rm(tmpDataDir, { recursive: true, force: true }));

  const expectedBinary = path.join(tmpDataDir, "bin", "codex", "codex-acp");
  await mkdir(path.dirname(expectedBinary), { recursive: true });
  await writeFile(expectedBinary, "#!/bin/sh\nexit 0\n");

  let smokeBinary: string | null = null;
  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => tmpDataDir,
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => {
        throw new Error("release metadata fetch should not run");
      },
      downloadAndExtract: async () => {
        throw new Error("download should not run");
      },
      startAgent: async ({ binary }) => {
        smokeBinary = binary;
        return { dispose: async () => {} };
      },
      now: fixedClock(["2026-05-15T10:00:00.000Z", "2026-05-15T10:00:01.000Z"]),
    },
  })) as InstallSuccess;

  assert.equal(result.ok, true);
  assert.equal(smokeBinary, expectedBinary);
  assert.equal(result.profile.binary, expectedBinary);
  assert.equal(result.profile.lastVerifiedAt, "2026-05-15T10:00:01.000Z");
});

test("installAndVerify github-release: fails install when release metadata cannot be fetched", async (t) => {
  const tmpDataDir = await mkdtemp(path.join(os.tmpdir(), "consult-install-"));
  t.after(() => rm(tmpDataDir, { recursive: true, force: true }));

  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => tmpDataDir,
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => {
        throw new Error("HTTP 404");
      },
      downloadAndExtract: async () => {
        throw new Error("download should not run");
      },
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.match(result.message, /release metadata fetch failed/);
  assert.match(result.message, /HTTP 404/);
});

test("installAndVerify github-release: surfaces a sha256 mismatch from the downloader", async (t) => {
  const tmpDataDir = await mkdtemp(path.join(os.tmpdir(), "consult-install-"));
  t.after(() => rm(tmpDataDir, { recursive: true, force: true }));

  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => tmpDataDir,
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => "sha256:expected",
      downloadAndExtract: async () => {
        throw new Error("sha256 mismatch on downloaded asset: expected sha256:expected, got sha256:actual");
      },
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.match(result.message, /sha256 mismatch/);
});

test("installAndVerify github-release: aborts with no-target message on an unsupported platform", async () => {
  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      detectTarget: () => null,
      downloadAndExtract: async () => {
        throw new Error("download should not run");
      },
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.match(result.message, /no prebuilt asset mapping/);
});

test("installAndVerify github-release: surfaces a download failure at the install stage", async () => {
  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => "/tmp/should-not-be-created",
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => "sha256:deadbeef",
      downloadAndExtract: async () => {
        const error: Error & { captured?: InstallCaptured } = new Error(
          "curl exited 22: 404 Not Found",
        );
        error.captured = { stdout: "", stderr: "404 Not Found", exitCode: 22 };
        throw error;
      },
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.match(result.message, /curl exited 22/);
  assert.equal(result.captured!.exitCode, 22);
});

test("installAndVerify github-release: fails at discover when the extracted archive is missing the binary", async (t) => {
  const tmpDataDir = await mkdtemp(path.join(os.tmpdir(), "consult-install-"));
  t.after(() => rm(tmpDataDir, { recursive: true, force: true }));

  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture(),
    deps: {
      dataDir: () => tmpDataDir,
      detectTarget: () => ({ triple: "x86_64-unknown-linux-gnu", archiveFormat: "tar.gz" }),
      fetchAssetDigest: async () => "sha256:deadbeef",
      downloadAndExtract: async ({ installRoot }) => {
        await mkdir(installRoot, { recursive: true });
        await writeFile(path.join(installRoot, "some-other-file"), "x");
      },
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "discover");
  assert.match(result.message, /codex-acp missing/);
});

test("installAndVerify rejects an unknown install type before any side effects", async () => {
  const result = (await installAndVerify({
    registryEntry: githubReleaseFixture({
      install: { type: "smoke-signal", repo: "x/y", version: "v1" },
    }),
    deps: {
      startAgent: async () => {
        throw new Error("smoke should not run");
      },
    },
  })) as InstallFailure;

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install");
  assert.match(result.message, /unsupported install type: smoke-signal/);
});

function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[index++];
}
