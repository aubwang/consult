import path from "node:path";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import { isInsideWorkspace } from "./path-safety.mts";
import type { AgentSandboxMode } from "./process-sandbox.mts";

const PATH_BEARING_KINDS = new Set(["read", "search", "edit", "delete", "move"]);
const READ_ONLY_DENIED_KINDS = new Set([
  "edit",
  "delete",
  "move",
  "switch_mode",
  "other",
]);
const TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

// Field names are matched after stripping separators and lowercasing, so a single
// spelling here also covers filePath / file_path / file-path / FilePath.
const PATH_FIELD_NAMES = new Set(
  [
    "path",
    "paths",
    "filePath",
    "filename",
    "file",
    "files",
    "cwd",
    "dir",
    "directory",
    "root",
    "pathname",
    "workdir",
    "workingDir",
    "notebookPath",
    "absolutePath",
    "outputPath",
    "source",
    "sourcePath",
    "dest",
    "destination",
    "destinationPath",
    "target",
    "targetPath",
    "to",
    "from",
    "oldPath",
    "newPath",
  ].map(normalizeFieldName),
);

// A malformed or hostile rawInput must not be able to exhaust the scan. Both caps
// fail closed: exceeding them denies the call rather than silently scanning less,
// so padding cannot be used to hide a path past the limit.
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_NODES = 5000;

export type PermissionMode = "write" | "read-only";

export type PermissionDecision =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: string };

export interface DecidePermissionOptions {
  request: Pick<RequestPermissionRequest, "toolCall">;
  mode: PermissionMode;
  workspaceRoot: string;
  allowFetch?: boolean;
  allowExecute?: boolean;
  sandbox?: AgentSandboxMode;
}

export async function decidePermission(
  {
    request,
    mode,
    workspaceRoot,
    allowFetch = false,
    allowExecute = false,
    sandbox = "off",
  }: DecidePermissionOptions,
): Promise<PermissionDecision> {
  if (mode !== "write" && mode !== "read-only") {
    throw new Error(`unknown permission mode: ${mode}`);
  }

  if (!request?.toolCall) {
    throw new Error("missing request.toolCall");
  }

  const kind = normalizeKind(request.toolCall.kind);

  if (PATH_BEARING_KINDS.has(kind)) {
    const scan = candidatePaths(request.toolCall);
    if (scan.exceeded) {
      return { allowed: false, reason: "rawInput exceeds path confinement limits" };
    }
    // Some ACP tool calls do not expose a path at all; there is nothing to confine.
    for (const targetPath of scan.paths) {
      if (!(await isConfined(targetPath, workspaceRoot))) {
        return { allowed: false, reason: `path outside workspace: ${targetPath}` };
      }
    }
  }

  if (kind === "execute") {
    const cwd = (request.toolCall.rawInput as { cwd?: string } | undefined)?.cwd ?? workspaceRoot;
    if (!(await isConfined(cwd, workspaceRoot))) {
      return { allowed: false, reason: `cwd outside workspace: ${cwd}` };
    }
    if (mode !== "write") {
      return { allowed: false, reason: "execute denied in read-only mode" };
    }
    if (allowExecute !== true) {
      return { allowed: false, reason: "execute denied in write mode (explicit opt-in required)" };
    }
    return {
      allowed: false,
      reason: "execute denied: proxy-confined network enforcement is unavailable",
    };
  }

  if (kind === "fetch") {
    return allowFetch
      ? { allowed: true }
      : {
          allowed: false,
          reason: `fetch denied in ${mode} mode (explicit opt-in required)`,
        };
  }

  if (mode === "write") {
    return { allowed: true };
  }

  if (READ_ONLY_DENIED_KINDS.has(kind)) {
    return { allowed: false, reason: `${kind} denied in read-only mode` };
  }

  return { allowed: true };
}

function normalizeKind(kind: unknown): string {
  const normalized = String(kind ?? "other")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();

  return TOOL_KINDS.has(normalized) ? normalized : "other";
}

function normalizeFieldName(key: string): string {
  return key.replaceAll(/[-_]/gu, "").toLowerCase();
}

interface ScanBudget {
  nodes: number;
  exceeded: boolean;
}

function candidatePaths(toolCall: RequestPermissionRequest["toolCall"]): {
  paths: string[];
  exceeded: boolean;
} {
  const paths = new Set<string>();

  // ACP types locations[].path as a file location, so it needs no name guessing.
  // The Broker's touched-file backstop already reads it; without this the
  // cooperative gate is strictly weaker than that backstop.
  for (const location of toolCall.locations ?? []) {
    if (typeof location?.path === "string") {
      paths.add(location.path);
    }
  }

  const budget: ScanBudget = { nodes: 0, exceeded: false };
  collectPaths(toolCall.rawInput, false, 0, budget, paths);
  return { paths: [...paths], exceeded: budget.exceeded };
}

function collectPaths(
  value: unknown,
  keyIsPathBearing: boolean,
  depth: number,
  budget: ScanBudget,
  out: Set<string>,
): void {
  if (budget.exceeded) {
    return;
  }
  if (depth > MAX_SCAN_DEPTH) {
    budget.exceeded = true;
    return;
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_SCAN_NODES) {
    budget.exceeded = true;
    return;
  }

  if (typeof value === "string") {
    if (keyIsPathBearing) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    // Arrays inherit their parent key so `paths: [...]` stays confined. Objects
    // deliberately do not: `{ from: { text: "/usr/bin" } }` describes a
    // structure, not a path, and inheriting there would deny legitimate calls.
    for (const entry of value) {
      collectPaths(entry, keyIsPathBearing, depth + 1, budget, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(
        nested,
        PATH_FIELD_NAMES.has(normalizeFieldName(key)),
        depth + 1,
        budget,
        out,
      );
    }
  }
}

async function isConfined(targetPath: string, workspaceRoot: string): Promise<boolean> {
  try {
    const resolvedTarget = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(workspaceRoot, targetPath);
    return await isInsideWorkspace(resolvedTarget, workspaceRoot);
  } catch {
    return false;
  }
}
