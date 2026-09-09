import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { RequestError } from "@agentclientprotocol/sdk";

import { createFsHandlers } from "./fs-handlers.mts";

const roots: string[] = [];

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
    (error: RequestError) => {
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
    (error: RequestError) => {
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
    (error: RequestError) => {
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
    (error: RequestError) => {
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
    (error: RequestError) => {
      assert.equal(error.name, "RequestError");
      assert.equal(error.code, -32602);
      assert.match(error.message, /path outside workspace/);
      return true;
    },
  );
});

test("a dangling link cannot create a file outside the Workspace through ACP", async () => {
  const workspaceRoot = await makeRoot();
  const outsideRoot = await makeRoot();
  const target = path.join(outsideRoot, "absent");
  const link = path.join(workspaceRoot, "link");
  await fs.symlink(target, link);
  await assert.rejects(createFsHandlers({ workspaceRoot, mode: "write" }).writeTextFile({
    sessionId: "session", path: link, content: "must not escape",
  }), /unsafe workspace path/);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("relative paths and existing internal symlinks address the Workspace", async () => {
  const workspaceRoot = await makeRoot();
  await fs.writeFile(path.join(workspaceRoot, "file"), "before");
  await fs.symlink("file", path.join(workspaceRoot, "link"));
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });
  await handlers.writeTextFile({ sessionId: "session", path: "link", content: "after" });
  assert.deepEqual(await handlers.readTextFile({ sessionId: "session", path: "file" }), { content: "after" });
});

test("Host writes reject Git metadata and multiply linked files", async () => {
  const workspaceRoot = await makeRoot();
  await fs.mkdir(path.join(workspaceRoot, ".git"));
  await fs.writeFile(path.join(workspaceRoot, "file"), "before");
  await fs.link(path.join(workspaceRoot, "file"), path.join(workspaceRoot, "alias"));
  const handlers = createFsHandlers({ workspaceRoot, mode: "write" });
  await assert.rejects(handlers.writeTextFile({ sessionId: "session", path: ".git/config", content: "bad" }), /Git metadata/);
  await assert.rejects(handlers.writeTextFile({ sessionId: "session", path: "alias", content: "bad" }), /multiply linked/);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "file"), "utf8"), "before");
});

test("replacing a parent with a symlink between validation and open cannot redirect a Host write", async (t) => {
  const workspaceRoot = await makeRoot();
  const outsideRoot = await makeRoot();
  const parent = path.join(workspaceRoot, "parent");
  await fs.mkdir(parent);
  const originalOpen = fs.open.bind(fs);
  let swapped = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const name = String(args[0]);
    if (!swapped && (process.platform === "linux" ? name.endsWith("/parent") : name.endsWith("/parent/new"))) {
      swapped = true;
      await fs.rename(parent, `${parent}-original`);
      await fs.symlink(outsideRoot, parent);
    }
    return originalOpen(...args);
  });
  await assert.rejects(createFsHandlers({ workspaceRoot, mode: "write" }).writeTextFile({
    sessionId: "session", path: "parent/new", content: "must not escape",
  }));
  assert.equal(swapped, true);
  await assert.rejects(fs.stat(path.join(outsideRoot, "new")), { code: "ENOENT" });
});
