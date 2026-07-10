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

const PATH_FIELD_NAMES = new Set([
  "path",
  "paths",
  "filePath",
  "file_path",
  "filename",
  "fileName",
  "cwd",
  "source",
  "sourcePath",
  "source_path",
  "dest",
  "destination",
  "destinationPath",
  "destination_path",
  "target",
  "targetPath",
  "target_path",
  "to",
  "from",
  "oldPath",
  "old_path",
  "newPath",
  "new_path",
]);

export type PermissionMode = "write" | "read-only";

export type PermissionDecision =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: string };

export interface DecidePermissionOptions {
  request: Pick<RequestPermissionRequest, "toolCall">;
  mode: PermissionMode;
  workspaceRoot: string;
  allowExecute?: boolean;
  sandbox?: AgentSandboxMode;
}

export async function decidePermission(
  {
    request,
    mode,
    workspaceRoot,
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
    const paths = candidatePaths(request.toolCall.rawInput);
    // Some ACP tool calls do not expose a path in rawInput; there is nothing to confine.
    for (const targetPath of paths) {
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
    return {
      allowed: false,
      reason: `fetch denied in ${mode} mode (exfil vector)`,
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

function candidatePaths(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return [];
  }

  const paths: string[] = [];
  for (const [key, value] of Object.entries(rawInput as Record<string, unknown>)) {
    if (!PATH_FIELD_NAMES.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      paths.push(value);
    } else if (Array.isArray(value)) {
      paths.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return paths;
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
