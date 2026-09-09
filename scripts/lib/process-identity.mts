import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function processStartTime(pid: number = process.pid): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
      });
      return stdout.trim() || null;
    } catch (error) {
      if ((error as { code?: string | number }).code === 1) {
        return null;
      }
      throw error;
    }
  }
  if (process.platform !== "linux") {
    return null;
  }
  const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) {
    return null;
  }
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const ticks = fieldsAfterCommand[19];
  if (!ticks) return null;
  const bootId = (await fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  return `${bootId}:${ticks}`;
}

export async function pidMatchesStartTime(
  pid: number,
  expectedStartTime: string | null | undefined,
): Promise<boolean> {
  if (!expectedStartTime) {
    return false;
  }
  try {
    return (await processStartTime(pid)) === expectedStartTime;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

export async function captureProcessGroupIdentity(groupId: number): Promise<() => Promise<boolean>> {
  const members = async (): Promise<number[]> => {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
    return stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, group]) => group === groupId).map(([pid]) => pid);
  };
  const identities = new Map<number, string>();
  for (const pid of await members()) {
    const start = await processStartTime(pid).catch(() => null);
    if (start) identities.set(pid, start);
  }
  return async () => {
    for (const pid of await members()) {
      const expected = identities.get(pid);
      if (expected && await pidMatchesStartTime(pid, expected)) return true;
    }
    return false;
  };
}
