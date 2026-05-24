import fs from "node:fs/promises";
import path from "node:path";

export async function resolveWorkspaceRoot(startPath = process.cwd()) {
  let currentPath = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(currentPath, ".git");
    try {
      const gitStat = await fs.stat(gitPath);
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return fs.realpath(currentPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      const error = new Error("No workspace found");
      error.code = "NO_WORKSPACE";
      throw error;
    }
    currentPath = parentPath;
  }
}
