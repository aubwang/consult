import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const source = path.join(root, "scripts", "consult-companion.mts");

if (await exists(source)) {
  if (!(await exists(tsc))) {
    throw new Error("TypeScript is not installed; run bun install before building the package");
  }
  await fs.rm(output, { recursive: true, force: true });
  await run(process.execPath, [tsc, "--project", path.join(root, "tsconfig.package.json")]);
  await fs.copyFile(
    path.join(root, "scripts", "registry.json"),
    path.join(output, "scripts", "registry.json"),
  );
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`package build failed (${signal ?? `exit ${code}`})`));
    });
  });
}
