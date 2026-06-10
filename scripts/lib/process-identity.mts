import fsp from "node:fs/promises";

export async function processStartTime(pid: number = process.pid): Promise<string | null> {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) {
    return null;
  }
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  return fieldsAfterCommand[19] ?? null;
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
