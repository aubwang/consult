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
      reason: "fetch denied in read-only mode (explicit opt-in required)",
    },
  );
});

test("write-mode denies fetch", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("fetch", { url: "https://example.invalid" }),
      mode: "write",
      workspaceRoot: makeRoot(),
      allowExecute: true,
      sandbox: "bwrap",
    }),
    {
      allowed: false,
      reason: "fetch denied in write mode (explicit opt-in required)",
    },
  );
});

test("explicit fetch authority permits ACP fetch requests in either mode", async () => {
  for (const mode of ["read-only", "write"] as const) {
    assert.deepEqual(
      await decidePermission({
        request: request("fetch", { url: "https://example.com" }),
        mode,
        workspaceRoot: makeRoot(),
        allowFetch: true,
      }),
      { allowed: true },
    );
  }
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

test("write-mode denies execute without explicit opt-in even under bwrap", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot }),
      mode: "write",
      workspaceRoot,
      sandbox: "bwrap",
    }),
    {
      allowed: false,
      reason: "execute denied in write mode (explicit opt-in required)",
    },
  );
});

test("write-mode does not treat an isolated worktree marker as execute opt-in", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot, isolatedWorkspace: true }),
      mode: "write",
      workspaceRoot,
      sandbox: "bwrap",
    }),
    {
      allowed: false,
      reason: "execute denied in write mode (explicit opt-in required)",
    },
  );
});

test("write-mode denies opted-in execute until proxy-confined networking is available", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot }),
      mode: "write",
      workspaceRoot,
      allowExecute: true,
      sandbox: "off",
    }),
    {
      allowed: false,
      reason: "execute denied: proxy-confined network enforcement is unavailable",
    },
  );
});

test("read-only denies opted-in execute under bwrap", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot }),
      mode: "read-only",
      workspaceRoot,
      allowExecute: true,
      sandbox: "bwrap",
    }),
    { allowed: false, reason: "execute denied in read-only mode" },
  );
});

test("write-mode denies opted-in bwrap execute with cwd outside workspace", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: "/tmp" }),
      mode: "write",
      workspaceRoot: makeRoot(),
      allowExecute: true,
      sandbox: "bwrap",
    }),
    { allowed: false, reason: "cwd outside workspace: /tmp" },
  );
});

test("write-mode denies explicitly opted-in execute under filesystem-only bwrap", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: request("execute", { cwd: workspaceRoot }),
      mode: "write",
      workspaceRoot,
      allowExecute: true,
      sandbox: "bwrap",
    }),
    {
      allowed: false,
      reason: "execute denied: proxy-confined network enforcement is unavailable",
    },
  );
});

test("write-mode treats an omitted execute cwd as the confined workspace root", async () => {
  assert.deepEqual(
    await decidePermission({
      request: request("execute", { command: "pwd" }),
      mode: "write",
      workspaceRoot: makeRoot(),
      allowExecute: true,
      sandbox: "bwrap",
    }),
    {
      allowed: false,
      reason: "execute denied: proxy-confined network enforcement is unavailable",
    },
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

test("path confinement reaches nested and array-wrapped rawInput shapes", async () => {
  const workspaceRoot = makeRoot();

  const shapes: Record<string, unknown>[] = [
    { edits: [{ file_path: "/etc/passwd" }] },
    { args: { path: "/etc/passwd" } },
    { batch: { edits: [{ nested: { target_path: "/etc/passwd" } }] } },
    { paths: ["/etc/passwd"] },
  ];

  for (const rawInput of shapes) {
    assert.deepEqual(
      await decidePermission({
        request: request("edit", rawInput),
        mode: "write",
        workspaceRoot,
      }),
      { allowed: false, reason: "path outside workspace: /etc/passwd" },
      `expected ${JSON.stringify(rawInput)} to be confined`,
    );
  }
});

test("path confinement scans a top-level array rawInput", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: {
        toolCall: {
          toolCallId: "tool-1",
          kind: "edit",
          rawInput: [{ file_path: "/etc/passwd" }] as unknown as Record<string, unknown>,
        },
      },
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "path outside workspace: /etc/passwd" },
  );
});

test("path confinement matches field names regardless of case and separators", async () => {
  const workspaceRoot = makeRoot();

  for (const key of ["FilePath", "File_Path", "file-path", "NOTEBOOK_PATH", "absolutePath"]) {
    assert.deepEqual(
      await decidePermission({
        request: request("edit", { [key]: "/etc/passwd" }),
        mode: "write",
        workspaceRoot,
      }),
      { allowed: false, reason: "path outside workspace: /etc/passwd" },
      `expected key '${key}' to be confined`,
    );
  }
});

test("path confinement covers newly recognized directory-style keys", async () => {
  const workspaceRoot = makeRoot();

  for (const key of ["directory", "dir", "root", "workdir", "files", "output_path"]) {
    assert.deepEqual(
      await decidePermission({
        request: request("read", { [key]: "/etc/passwd" }),
        mode: "read-only",
        workspaceRoot,
      }),
      { allowed: false, reason: "path outside workspace: /etc/passwd" },
      `expected key '${key}' to be confined`,
    );
  }
});

test("path confinement uses the typed toolCall.locations source", async () => {
  const workspaceRoot = makeRoot();

  assert.deepEqual(
    await decidePermission({
      request: {
        toolCall: {
          toolCallId: "tool-1",
          kind: "edit",
          rawInput: {},
          locations: [{ path: "/etc/passwd" }],
        },
      },
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "path outside workspace: /etc/passwd" },
  );
});

test("nested objects do not inherit a path-bearing parent key", async () => {
  const workspaceRoot = makeRoot();

  // `from` is path-bearing, but a nested object under it describes a structure.
  // Inheriting the key here would deny a legitimate edit payload.
  assert.deepEqual(
    await decidePermission({
      request: request("edit", { from: { line: 1, text: "/usr/bin/env node" } }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
});

test("nested in-workspace paths remain allowed", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("edit", {
        edits: [{ file_path: targetPath }, { file_path: "child.txt" }],
        content: "https://example.com and/or **/*.mts",
      }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
});

test("path confinement fails closed when rawInput exceeds the scan depth", async () => {
  const workspaceRoot = makeRoot();

  let deep: Record<string, unknown> = { path: "/etc/passwd" };
  for (let index = 0; index < 40; index += 1) {
    deep = { wrapper: deep };
  }

  assert.deepEqual(
    await decidePermission({
      request: request("edit", deep),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: false, reason: "rawInput exceeds path confinement limits" },
  );
});

test("write-mode confines paths on unrecognized tool kinds", async () => {
  const workspaceRoot = makeRoot();

  // An unknown kind normalizes to `other`; before this was path-bearing it hit
  // the write-mode blanket allow with no confinement.
  for (const kind of ["custom_write", "unknown", "other"]) {
    assert.deepEqual(
      await decidePermission({
        request: request(kind as unknown as ToolKind, { path: "/etc/passwd" }),
        mode: "write",
        workspaceRoot,
      }),
      { allowed: false, reason: "path outside workspace: /etc/passwd" },
      `expected kind '${kind}' to be confined`,
    );
  }
});

test("write-mode still allows unrecognized tool kinds inside the workspace", async () => {
  const workspaceRoot = makeRoot();
  const targetPath = path.join(workspaceRoot, "notes.txt");
  fs.writeFileSync(targetPath, "hello", "utf8");

  assert.deepEqual(
    await decidePermission({
      request: request("custom_write" as unknown as ToolKind, { path: targetPath }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
  // No path at all remains allowed in write mode; there is nothing to confine.
  assert.deepEqual(
    await decidePermission({
      request: request("custom_write" as unknown as ToolKind, { note: "no path here" }),
      mode: "write",
      workspaceRoot,
    }),
    { allowed: true },
  );
});
