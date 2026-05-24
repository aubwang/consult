import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getDiff({ baseRef = null, cwd }) {
  const status = await git(cwd, "status", "--porcelain");
  const diffArgs = baseRef ? ["diff", `${baseRef}...HEAD`] : ["diff"];
  const diff = await git(cwd, ...diffArgs);
  return [status, diff].filter((part) => part.length > 0).join("\n");
}

export async function gitRoot(cwd) {
  return (await git(cwd, "rev-parse", "--show-toplevel")).trim();
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}
