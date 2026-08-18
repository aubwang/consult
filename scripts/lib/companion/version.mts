import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The companion runs from `scripts/` in a checkout and from `dist/scripts/` in
// an installed package, so the package root sits at a different depth in each
// layout. Walk up until a package.json with a version appears rather than
// hard-coding either depth.
export function resolvePackageVersion(moduleUrl: string = import.meta.url): string {
  const root = resolvePackageRoot(moduleUrl);
  return root ? readVersion(path.join(root, "package.json")) ?? "unknown" : "unknown";
}

// The directory of the nearest package.json carrying a version, which is the
// package root in both the checkout and the installed layout.
export function resolvePackageRoot(moduleUrl: string = import.meta.url): string | null {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (readVersion(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readVersion(manifestPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
