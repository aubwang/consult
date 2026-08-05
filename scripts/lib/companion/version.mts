import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The companion runs from `scripts/` in a checkout and from `dist/scripts/` in
// an installed package, so the package root sits at a different depth in each
// layout. Walk up until a package.json with a version appears rather than
// hard-coding either depth.
export function resolvePackageVersion(moduleUrl: string = import.meta.url): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    const version = readVersion(manifestPath);
    if (version) return version;
    const parent = path.dirname(directory);
    if (parent === directory) return "unknown";
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
