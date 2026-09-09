import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { resolveInsideWorkspace } from "./path-safety.mts";

// Darwin's public open(2) flag rejects symlinks in every path component.
// Node/libuv accepts numeric native flags but does not export this constant.
// https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

export function isGitMetadataPath(target: string, root: string): boolean {
  return path.relative(root, target).split(path.sep).some((part) => part.toLowerCase() === ".git");
}

/** Open once, then perform all IO through the returned descriptor. */
export async function openWorkspaceFile(
  target: string,
  workspaceRoot: string,
  write: boolean,
): Promise<FileHandle> {
  const root = await fs.realpath(workspaceRoot);
  const absolute = path.resolve(root, target);
  const resolved = await resolveInsideWorkspace(absolute, root);
  if (!resolved) throw new Error(`path outside workspace: ${target}`);
  if (write && (isGitMetadataPath(absolute, root) || isGitMetadataPath(resolved, root))) {
    throw new Error(`write denied to Git metadata: ${target}`);
  }
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY);
  let file: FileHandle;
  if (process.platform === "linux") {
    // A descriptor pins each directory while we open its child without following
    // links. Replacing an ancestor with a symlink cannot redirect the Host IO.
    const parts = path.relative(root, resolved).split(path.sep);
    let directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of parts.slice(0, -1)) {
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      file = await fs.open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, flags, 0o600);
    } finally {
      await directory.close();
    }
  } else if (process.platform === "darwin") {
    // Darwin rejects O_NOFOLLOW combined with O_NOFOLLOW_ANY (EINVAL).
    // The latter already covers the final component as well as ancestors.
    file = await fs.open(resolved, (flags & ~constants.O_NOFOLLOW) | DARWIN_O_NOFOLLOW_ANY, 0o600);
  } else {
    throw new Error("workspace filesystem requests require Linux or macOS");
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`not a regular workspace file: ${target}`);
    if (write && info.nlink !== 1) throw new Error(`write denied to multiply linked file: ${target}`);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
