import path from "node:path";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import { resolveInsideWorkspace } from "./path-safety.mts";
import { openWorkspaceFile } from "./workspace-files.mts";

export type FsHandlerMode = "write" | "read-only";

export interface CreateFsHandlersOptions {
  workspaceRoot: string;
  mode: FsHandlerMode;
}

export interface FsHandlers {
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

export function createFsHandlers({ workspaceRoot, mode }: CreateFsHandlersOptions): FsHandlers {
  if (mode !== "write" && mode !== "read-only") {
    throw new Error(`unknown fs handler mode: ${mode}`);
  }

    return {
      async readTextFile(params) {
        await resolveWorkspacePath(params.path, workspaceRoot);
        const file = await openFile(path.resolve(workspaceRoot, params.path), workspaceRoot, false);
        try {
          return { content: applyLineWindow(await file.readFile("utf8"), params) };
        } finally {
          await file.close();
        }
      },
      async writeTextFile(params) {
        await resolveWorkspacePath(params.path, workspaceRoot);
        if (mode === "read-only") {
          throw RequestError.invalidParams(
            { path: params.path },
            "write denied in read-only mode",
          );
        }
        const file = await openFile(path.resolve(workspaceRoot, params.path), workspaceRoot, true);
        try {
          await file.truncate(0);
          await file.writeFile(params.content, "utf8");
        } finally {
          await file.close();
        }
        return {};
      },
    };
}

function applyLineWindow(
  content: string,
  { line, limit }: Pick<ReadTextFileRequest, "line" | "limit">,
): string {
  if (line == null && limit == null) {
    return content;
  }

  const lines = splitLinesPreservingTerminators(content);
  const start = line == null ? 0 : Math.max(0, line - 1);
  const end = limit == null ? undefined : start + limit;
  return lines.slice(start, end).join("");
}

function splitLinesPreservingTerminators(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

async function resolveWorkspacePath(targetPath: string, workspaceRoot: string): Promise<string> {
  let resolvedPath: string | null;
  try {
    resolvedPath = await resolveInsideWorkspace(path.resolve(workspaceRoot, targetPath), workspaceRoot);
  } catch {
    throw RequestError.invalidParams({ path: targetPath }, `unsafe workspace path: ${targetPath}`);
  }
  if (!resolvedPath) {
    throw RequestError.invalidParams(
      { path: targetPath },
      `path outside workspace: ${targetPath}`,
    );
  }
  return resolvedPath;
}

async function openFile(target: string, root: string, write: boolean) {
  try {
    return await openWorkspaceFile(target, root, write);
  } catch (error) {
    throw RequestError.invalidParams({ path: target }, (error as Error).message);
  }
}
