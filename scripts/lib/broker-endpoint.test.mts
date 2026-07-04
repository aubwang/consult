import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  brokerFilePath,
  brokersDir,
  brokerSocketPath,
  dataDir,
  overrideFilePath,
  profilesPath,
  workspaceDir,
  workspaceHash,
} from "./broker-endpoint.mts";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "consult-broker-"));
  roots.push(workspace);
  return workspace;
}

after(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("workspaceHash is deterministic for the same workspace", async () => {
  const workspace = await makeWorkspace();

  assert.equal(workspaceHash(workspace), workspaceHash(workspace));
});

test("workspaceHash is the same for a symlinked workspace alias", async () => {
  const workspace = await makeWorkspace();
  const alias = `${workspace}-alias`;
  roots.push(alias);
  await fs.symlink(workspace, alias, "dir");

  assert.equal(workspaceHash(alias), workspaceHash(workspace));
});

test("dataDir honors CONSULT_DATA_DIR", async () => {
  const previousDataDir = process.env.CONSULT_DATA_DIR;
  const override = path.join(await makeWorkspace(), "data");

  try {
    process.env.CONSULT_DATA_DIR = override;
    assert.equal(dataDir(), override);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = previousDataDir;
    }
  }
});

test("brokerFilePath is keyed by job id under the workspace brokers directory", async () => {
  const workspace = await makeWorkspace();
  const brokerFile = brokerFilePath({ workspaceRoot: workspace, jobId: "job-abc_123" });

  assert.equal(path.dirname(brokerFile), brokersDir(workspace));
  assert.equal(path.basename(brokerFile), "job-abc_123.json");
});

test("brokerSocketPath fits inside the Unix-domain socket path budget", async () => {
  const workspace = await makeWorkspace();
  const socketPath = brokerSocketPath({
    workspaceRoot: workspace,
    jobId: "job-".repeat(20),
  });

  assert.ok(socketPath.length <= 100, socketPath);
});

test("brokerSocketPath includes job id and workspace hash prefix", async () => {
  const workspace = await makeWorkspace();
  const jobId = "job-1";
  const socketPath = brokerSocketPath({ workspaceRoot: workspace, jobId });

  assert.match(
    path.basename(socketPath),
    new RegExp(`^(consult-)?${workspaceHash(workspace).slice(0, 12)}-job-${jobId}-[a-f0-9]+\\.sock$`),
  );
  assert.ok(socketPath.length <= 100, socketPath);
});

test("brokerSocketPath falls back to tmp when XDG_RUNTIME_DIR is unusable", async () => {
  const workspace = await makeWorkspace();
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;

  try {
    process.env.XDG_RUNTIME_DIR = path.join(workspace, "missing-runtime");
    const socketPath = brokerSocketPath({
      workspaceRoot: workspace,
      jobId: "job-1",
    });

    assert.equal(path.dirname(socketPath), os.tmpdir());
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
  }
});

test("brokerSocketPath errors instead of truncating the identity hash away", async () => {
  const workspace = await makeWorkspace();
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const previousTmpdir = process.env.TMPDIR;

  try {
    delete process.env.XDG_RUNTIME_DIR;
    process.env.TMPDIR = path.join(workspace, "x".repeat(80));
    assert.throws(
      () => brokerSocketPath({ workspaceRoot: workspace, jobId: "job-1" }),
      /broker socket path exceeds/,
    );
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    }
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
  }
});

test("brokerSocketPath is stable and differs by job id", async () => {
  const workspace = await makeWorkspace();
  const firstInput = {
    workspaceRoot: workspace,
    jobId: "job-1",
  };
  const secondInput = { ...firstInput, jobId: "job-2" };

  assert.equal(brokerSocketPath(firstInput), brokerSocketPath(firstInput));
  assert.notEqual(brokerSocketPath(firstInput), brokerSocketPath(secondInput));
});

test("profilesPath is global under the data directory", () => {
  assert.equal(profilesPath(), path.join(dataDir(), "profiles.json"));
});

test("overrideFilePath is under the per-workspace directory", async () => {
  const workspace = await makeWorkspace();

  assert.equal(overrideFilePath(workspace), path.join(workspaceDir(workspace), "override.json"));
});
