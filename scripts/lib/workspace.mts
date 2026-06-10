import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspaceError extends Error {
  code?: string;
}

export async function resolveWorkspaceRoot(startPath: string = process.cwd()): Promise<string> {
  let currentPath = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(currentPath, ".git");
    try {
      const gitStat = await fs.stat(gitPath);
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return fs.realpath(currentPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      const error: WorkspaceError = new Error("No workspace found");
      error.code = "NO_WORKSPACE";
      throw error;
    }
    currentPath = parentPath;
  }
}
