import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";

import { decidePermission, type PermissionMode } from "./permissions.mts";

const roots: string[] = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-"));
  roots.push(root);
  return root;
}

function request(
  kind: ToolKind,
  rawInput: Record<string, unknown> = {},
): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    options: [],
    toolCall: {
      toolCallId: "tool-1",
      kind,
      rawInput,
    },
  };
}

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("write-mode allows read inside workspace", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("read", { path: targetPath }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
});

test("write-mode denies read outside workspace", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("read", { path: "/etc/passwd" }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "path outside workspace: /etc/passwd" },
  );
});

test("read-only allows read inside workspace", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("read", { path: targetPath }),
      mode: "read-only",
      workspaceRoot,
    }),
    { allowed: true },
  );
});

test("read-only denies fetch", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("fetch", { url: "https://example.invalid" }),
      mode: "read-only",
      workspaceRoot: makeRoot(),
    }),
    {
      allowed: false,
      reason: "fetch denied in read-only mode (exfil vector)",
    },
  );
});

test("write-mode denies fetch", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("fetch", { url: "https://example.invalid" }),
      mode: "write",
      workspaceRoot: makeRoot(),
    }),
    {
      allowed: false,
      reason: "fetch denied in write mode (exfil vector)",
    },
  );
});

test("read-only denies edit even inside workspace", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("edit", { path: targetPath }),
      mode: "read-only",
      workspaceRoot,
    }),
    { allowed: false, reason: "edit denied in read-only mode" },
  );
});

test("write-mode allows edit inside workspace and denies edit outside workspace", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("edit", { path: targetPath }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
  assert.deepEqual(
    await decidePermission({
      request: request("edit", { path: "/etc/passwd" }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "path outside workspace: /etc/passwd" },
  );
});

test("path confinement covers alternate destination-style rawInput keys", async () => {
  const workspaceRoot = makeRoot();

  for (const key of ["dest", "destination", "target", "to", "from", "source"]) {
    assert.deepEqual(
      await decidePermission({
        request: request("move", { [key]: "/etc/passwd" }),
        mode: "write",
        workspaceRoot,
      }),
      { allowed: false, reason: "path outside workspace: /etc/passwd" },
      `expected key '${key}' to be confined`,
    );
  }
});

test("write-mode denies execute even with cwd inside workspace", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "execute denied in write mode" },
  );
});

test("write-mode denies execute with cwd outside workspace", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: "/tmp" }),
      mode: "write",
      workspaceRoot: makeRoot(),
    }),
    { allowed: false, reason: "cwd outside workspace: /tmp" },
  );
});

test("write-mode denies execute with no cwd", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("execute", { command: "pwd" }),
      mode: "write",
      workspaceRoot: makeRoot(),
    }),
    { allowed: false, reason: "execute denied in write mode" },
  );
});

test("read-only denies switch_mode and other", async () => {
  for (const kind of ["switch_mode", "other"] as const) {
    assert.deepEqual(
      await decidePermission({
        request: request(kind),
        mode: "read-only",
        workspaceRoot: makeRoot(),
      }),
      { allowed: false, reason: `${kind} denied in read-only mode` },
    );
  }
});

test("unknown mode throws", async () => {
  await assert.rejects(
    decidePermission({
      request: request("read"),
      mode: "supervised" as unknown as PermissionMode,
      workspaceRoot: makeRoot(),
    }),
    /unknown permission mode: supervised/,
  );
});
