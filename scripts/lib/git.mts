import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GetDiffOptions {
  baseRef?: string | null;
  cwd: string;
}

export async function getDiff({ baseRef = null, cwd }: GetDiffOptions): Promise<string> {
  const status = await git(cwd, "status", "--porcelain");
  // --end-of-options stops a baseRef starting with '-' from injecting git options.
  const diffArgs = baseRef ? ["diff", "--end-of-options", `${baseRef}...HEAD`] : ["diff"];
  const diff = await git(cwd, ...diffArgs);
  return [status, diff].filter((part) => part.length > 0).join("\n");
}

export async function gitRoot(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse", "--show-toplevel")).trim();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}
