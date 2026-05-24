import fs from "node:fs/promises";

import { RequestError } from "@agentclientprotocol/sdk";

import { isInsideWorkspace } from "./path-safety.mjs";

export function createFsHandlers({ workspaceRoot, mode }) {
  if (mode !== "write" && mode !== "read-only") {
    throw new Error(`unknown fs handler mode: ${mode}`);
  }

  return {
    async readTextFile(params) {
      await assertInsideWorkspace(params.path, workspaceRoot);
      const content = await fs.readFile(params.path, "utf8");
      return { content: applyLineWindow(content, params) };
    },
    async writeTextFile(params) {
      await assertInsideWorkspace(params.path, workspaceRoot);
      if (mode === "read-only") {
        throw RequestError.invalidParams(
          { path: params.path },
          "write denied in read-only mode",
        );
      }
      await fs.writeFile(params.path, params.content, "utf8");
      return {};
    },
  };
}

function applyLineWindow(content, { line, limit }) {
  if (line == null && limit == null) {
    return content;
  }

  const lines = splitLinesPreservingTerminators(content);
  const start = line == null ? 0 : Math.max(0, line - 1);
  const end = limit == null ? undefined : start + limit;
  return lines.slice(start, end).join("");
}

function splitLinesPreservingTerminators(content) {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

async function assertInsideWorkspace(targetPath, workspaceRoot) {
  if (!(await isInsideWorkspace(targetPath, workspaceRoot))) {
    throw RequestError.invalidParams(
      { path: targetPath },
      `path outside workspace: ${targetPath}`,
    );
  }
}
