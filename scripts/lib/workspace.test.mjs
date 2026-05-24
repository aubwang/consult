import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const roots = [];
const execFileAsync = promisify(execFile);

function makeRoot(baseDir = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(baseDir, "consult-workspace-"));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

test("resolveWorkspaceRoot detects git root when called from the root itself", async () => {
  const workspace = makeRoot();
  await fsp.mkdir(path.join(workspace, ".git"));

  assert.equal(await resolveWorkspaceRoot(workspace), await fsp.realpath(workspace));
});

test("resolveWorkspaceRoot detects git root from a nested subdirectory", async () => {
  const workspace = makeRoot();
  await execFileAsync("git", ["init"], { cwd: workspace });
  const nestedDir = path.join(workspace, "sub", "sub2");
  await fsp.mkdir(nestedDir, { recursive: true });

  assert.equal(await resolveWorkspaceRoot(nestedDir), await fsp.realpath(workspace));
});

test("resolveWorkspaceRoot throws NO_WORKSPACE when no git ancestor exists", async () => {
  const dir = makeRoot(nonWorkspaceTempBase());

  await assert.rejects(resolveWorkspaceRoot(dir), { code: "NO_WORKSPACE" });
});

test("resolveWorkspaceRoot handles git metadata as a regular file", async () => {
  const workspace = makeRoot();
  await fsp.writeFile(path.join(workspace, ".git"), "gitdir: ../main/.git/worktrees/ws\n", "utf8");

  assert.equal(await resolveWorkspaceRoot(workspace), await fsp.realpath(workspace));
});

function nonWorkspaceTempBase() {
  for (const candidate of [os.tmpdir(), "/var/tmp", "/dev/shm"]) {
    if (candidate && fs.existsSync(candidate) && !hasGitAncestor(candidate)) {
      return candidate;
    }
  }
  throw new Error("could not find temp directory without a .git ancestor");
}

function hasGitAncestor(startPath) {
  let currentPath = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(currentPath, ".git"))) {
      return true;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
}
