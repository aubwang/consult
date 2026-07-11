import fs from "node:fs/promises";

export async function readJsonWhenReady(
  file: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 200;
  const delayMs = options.delayMs ?? 50;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingFileError(error)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`timed out waiting for complete JSON in ${file}`, { cause: lastError });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
