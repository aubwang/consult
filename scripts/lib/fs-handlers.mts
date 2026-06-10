import fs from "node:fs/promises";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import { resolveInsideWorkspace } from "./path-safety.mts";

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
        const safePath = await resolveWorkspacePath(params.path, workspaceRoot);
        const content = await fs.readFile(safePath, "utf8");
        return { content: applyLineWindow(content, params) };
      },
      async writeTextFile(params) {
        const safePath = await resolveWorkspacePath(params.path, workspaceRoot);
        if (mode === "read-only") {
          throw RequestError.invalidParams(
            { path: params.path },
            "write denied in read-only mode",
          );
        }
        await fs.writeFile(safePath, params.content, "utf8");
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
  const resolvedPath = await resolveInsideWorkspace(targetPath, workspaceRoot);
  if (!resolvedPath) {
    throw RequestError.invalidParams(
      { path: targetPath },
      `path outside workspace: ${targetPath}`,
    );
  }
  return resolvedPath;
}
