import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { isInsideWorkspace, resolveInsideWorkspace } from "./path-safety.mjs";

const roots = [];

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "path-safety-"));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("isInsideWorkspace returns true for an existing path inside the workspace", async () => {
  const workspace = await makeRoot();
  const targetPath = path.join(workspace, "notes.txt");
  await fs.writeFile(targetPath, "hello", "utf8");

  assert.equal(await isInsideWorkspace(targetPath, workspace), true);
});

test("isInsideWorkspace returns false for a path outside the workspace", async () => {
  const workspace = await makeRoot();

  assert.equal(await isInsideWorkspace("/etc/passwd", workspace), false);
});

test("isInsideWorkspace returns false for a workspace symlink that resolves outside", async () => {
  const workspace = await makeRoot();
  const targetPath = path.join(workspace, "passwd-link");
  await fs.symlink("/etc/passwd", targetPath);

  assert.equal(await isInsideWorkspace(targetPath, workspace), false);
});

test("resolveInsideWorkspace returns the resolved in-workspace target path", async () => {
  const workspace = await makeRoot();
  const targetPath = path.join(workspace, "notes.txt");
  const linkPath = path.join(workspace, "notes-link.txt");
  await fs.writeFile(targetPath, "hello", "utf8");
  await fs.symlink(targetPath, linkPath);

  assert.equal(await resolveInsideWorkspace(linkPath, workspace), await fs.realpath(targetPath));
});

test("isInsideWorkspace returns true for a missing path with an existing workspace parent", async () => {
  const workspace = await makeRoot();
  const parentDir = path.join(workspace, "notes");
  await fs.mkdir(parentDir);

  assert.equal(await isInsideWorkspace(path.join(parentDir, "new.txt"), workspace), true);
});

test("isInsideWorkspace propagates the I/O error when a missing path parent is also missing", async () => {
  const workspace = await makeRoot();

  await assert.rejects(
    isInsideWorkspace(path.join(workspace, "missing", "new.txt"), workspace),
    { code: "ENOENT" },
  );
});

test("isInsideWorkspace returns true when the workspace root is passed as a symlink", async () => {
  const workspace = await makeRoot();
  const linkedWorkspace = `${workspace}-link`;
  roots.push(linkedWorkspace);
  await fs.symlink(workspace, linkedWorkspace, "dir");
  const targetPath = path.join(workspace, "notes.txt");
  await fs.writeFile(targetPath, "hello", "utf8");

  assert.equal(await isInsideWorkspace(targetPath, linkedWorkspace), true);
});

test("isInsideWorkspace returns false when dot-dot segments resolve outside the workspace", async () => {
  const base = await makeRoot();
  const workspace = path.join(base, "workspace");
  await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
  await fs.mkdir(path.join(base, "etc"));
  const outsidePath = path.join(base, "etc", "passwd");
  await fs.writeFile(outsidePath, "outside", "utf8");

  const targetPath = `${workspace}${path.sep}sub${path.sep}..${path.sep}..${path.sep}etc${path.sep}passwd`;
  assert.equal(await isInsideWorkspace(targetPath, workspace), false);
});
