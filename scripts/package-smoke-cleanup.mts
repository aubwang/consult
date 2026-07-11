import fs from "node:fs/promises";

interface CleanupDependencies {
  remove?: (
    temporaryRoot: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}

export async function removePackageTemporaryRoot(
  temporaryRoot: string,
  { remove = fs.rm, wait = delay }: CleanupDependencies = {},
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await remove(temporaryRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
        throw error;
      }
      await wait(10 * (attempt + 1));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
