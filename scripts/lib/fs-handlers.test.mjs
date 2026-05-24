import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createFsHandlers } from "./fs-handlers.mjs";

const roots = [];

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-handlers-"));
  roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("readTextFile returns the content of a workspace file", async () => {
  const workspaceRoot = await makeRoot();
  const filePath = path.join(workspaceRoot, "notes.txt");
  await fs.writeFile(filePath, "hello\nworld\n", "utf8");
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });

  assert.deepEqual(
    await handlers.readTextFile({ sessionId: "sess-1", path: filePath }),
    { content: "hello\nworld\n" },
  );
});

test("readTextFile rejects paths outside the workspace", async () => {
  const handlers = createFsHandlers({
    workspaceRoot: await makeRoot(),
    mode: "write",
  });

  await assert.rejects(
    handlers.readTextFile({ sessionId: "sess-1", path: "/etc/passwd" }),
    (error) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /path outside workspace/);
      return true;
    },
  );
});

test("readTextFile rejects a workspace symlink that resolves outside", async () => {
  const workspaceRoot = await makeRoot();
  const outsideRoot = await makeRoot();
  const outsidePath = path.join(outsideRoot, "secret.txt");
  const linkPath = path.join(workspaceRoot, "secret-link.txt");
  await fs.writeFile(outsidePath, "secret\n", "utf8");
  await fs.symlink(outsidePath, linkPath);
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });

  await assert.rejects(
    handlers.readTextFile({ sessionId: "sess-1", path: linkPath }),
    (error) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /path outside workspace/);
      return true;
    },
  );
});

test("readTextFile returns a bounded line window when line and limit are provided", async () => {
  const workspaceRoot = await makeRoot();
  const filePath = path.join(workspaceRoot, "notes.txt");
  await fs.writeFile(filePath, "one\ntwo\nthree\nfour\n", "utf8");
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });

  assert.deepEqual(
    await handlers.readTextFile({
      sessionId: "sess-1",
      path: filePath,
      line: 2,
      limit: 2,
    }),
    { content: "two\nthree\n" },
  );
});

test("writeTextFile writes content to a workspace file in write mode", async () => {
  const workspaceRoot = await makeRoot();
  const filePath = path.join(workspaceRoot, "notes.txt");
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });

  assert.deepEqual(
    await handlers.writeTextFile({
      sessionId: "sess-1",
      path: filePath,
      content: "updated\n",
    }),
    {},
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "updated\n");
});

test("writeTextFile rejects a workspace symlink that resolves outside", async () => {
  const workspaceRoot = await makeRoot();
  const outsideRoot = await makeRoot();
  const outsidePath = path.join(outsideRoot, "secret.txt");
  const linkPath = path.join(workspaceRoot, "secret-link.txt");
  await fs.writeFile(outsidePath, "secret\n", "utf8");
  await fs.symlink(outsidePath, linkPath);
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });

  await assert.rejects(
    handlers.writeTextFile({
      sessionId: "sess-1",
      path: linkPath,
      content: "changed\n",
    }),
    (error) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /path outside workspace/);
      return true;
    },
  );
  assert.equal(await fs.readFile(outsidePath, "utf8"), "secret\n");
});

test("writeTextFile rejects writes in read-only mode without changing the file", async () => {
  const workspaceRoot = await makeRoot();
  const filePath = path.join(workspaceRoot, "notes.txt");
  await fs.writeFile(filePath, "original\n", "utf8");
  const handlers = createFsHandlers({ workspaceRoot, mode: "read-only" });

  await assert.rejects(
    handlers.writeTextFile({
      sessionId: "sess-1",
      path: filePath,
      content: "changed\n",
    }),
    (error) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /write denied in read-only mode/);
      return true;
    },
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "original\n");
});

test("writeTextFile applies workspace confinement before read-only denial", async () => {
  const handlers = createFsHandlers({
    workspaceRoot: await makeRoot(),
    mode: "read-only",
  });

  await assert.rejects(
    handlers.writeTextFile({
      sessionId: "sess-1",
      path: "/etc/passwd",
      content: "changed\n",
    }),
    (error) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /path outside workspace/);
      return true;
    },
  );
});
