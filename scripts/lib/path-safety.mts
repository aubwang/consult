import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function isInsideWorkspace(
  targetPath: string,
  workspaceRoot: string,
): Promise<boolean> {
  return (await resolveInsideWorkspace(targetPath, workspaceRoot)) !== null;
}

export async function resolveInsideWorkspace(
  targetPath: string,
  workspaceRoot: string,
): Promise<string | null> {
  const [resolvedTarget, resolvedRoot] = await Promise.all([
    resolveTargetPath(targetPath),
    fs.realpath(workspaceRoot),
  ]);
  return isInsideResolvedWorkspace(resolvedTarget, resolvedRoot) ? resolvedTarget : null;
}

export function isInsideWorkspaceSync(targetPath: string, workspaceRoot: string): boolean {
  const resolvedTarget = resolveTargetPathSync(targetPath);
  const resolvedRoot = syncFs.realpathSync(workspaceRoot);
  return isInsideResolvedWorkspace(resolvedTarget, resolvedRoot);
}

function isInsideResolvedWorkspace(resolvedTarget: string, resolvedRoot: string): boolean {
  const relativePath = path.relative(resolvedRoot, resolvedTarget);

  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

async function resolveTargetPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }

    // A missing parent is a real I/O error; callers need that distinction.
    const parentDir = await fs.realpath(path.dirname(targetPath));
    return path.join(parentDir, path.basename(targetPath));
  }
}

function resolveTargetPathSync(targetPath: string): string {
  try {
    return syncFs.realpathSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }

    // A missing parent is a real I/O error; callers need that distinction.
    const parentDir = syncFs.realpathSync(path.dirname(targetPath));
    return path.join(parentDir, path.basename(targetPath));
  }
}
