import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function isInsideWorkspace(targetPath, workspaceRoot) {
  return (await resolveInsideWorkspace(targetPath, workspaceRoot)) !== null;
}

export async function resolveInsideWorkspace(targetPath, workspaceRoot) {
  const [resolvedTarget, resolvedRoot] = await Promise.all([
    resolveTargetPath(targetPath),
    fs.realpath(workspaceRoot),
  ]);
  return isInsideResolvedWorkspace(resolvedTarget, resolvedRoot) ? resolvedTarget : null;
}

export function isInsideWorkspaceSync(targetPath, workspaceRoot) {
  const resolvedTarget = resolveTargetPathSync(targetPath);
  const resolvedRoot = syncFs.realpathSync(workspaceRoot);
  return isInsideResolvedWorkspace(resolvedTarget, resolvedRoot);
}

function isInsideResolvedWorkspace(resolvedTarget, resolvedRoot) {
  const relativePath = path.relative(resolvedRoot, resolvedTarget);

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

async function resolveTargetPath(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    // A missing parent is a real I/O error; callers need that distinction.
    const parentDir = await fs.realpath(path.dirname(targetPath));
    return path.join(parentDir, path.basename(targetPath));
  }
}

function resolveTargetPathSync(targetPath) {
  try {
    return syncFs.realpathSync(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    // A missing parent is a real I/O error; callers need that distinction.
    const parentDir = syncFs.realpathSync(path.dirname(targetPath));
    return path.join(parentDir, path.basename(targetPath));
  }
}
