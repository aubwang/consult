import fs from "node:fs/promises";

import { jobLogPath } from "./job-records.mts";

export interface ParsedJobLog {
  entries: unknown[];
  lineCount: number;
}

export interface ReadJobLogOptions {
  readLogFile?: (path: string) => Promise<string>;
  dropPartialTail?: boolean;
}

// The per-job log is strict NDJSON: one JSON object per line. Reading it is
// shared by `logs`, `events`, and `report`, so the strictness and the
// JOB_LOG_MALFORMED contract live in one place.
export async function readJobLogEntries(
  workspaceRoot: string,
  jobId: string,
  { readLogFile = defaultReadLogFile, dropPartialTail = false }: ReadJobLogOptions = {},
): Promise<ParsedJobLog> {
  let contents: string;
  const path = jobLogPath(workspaceRoot, jobId);
  try {
    contents = await readLogFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], lineCount: 0 };
    }
    throw error;
  }
  return parseJobLog(contents, path, { dropPartialTail });
}

export function parseJobLog(
  contents: string,
  path: string,
  { dropPartialTail = false }: { dropPartialTail?: boolean } = {},
): ParsedJobLog {
  let text = contents;
  if (dropPartialTail && !text.endsWith("\n")) {
    // A writer may still be flushing the trailing line; parse it on a later read.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const entries: unknown[] = [];
  if (lines.length === 1 && lines[0] === "") {
    return { entries, lineCount: 0 };
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new SyntaxError("log entry is not an object");
      }
      entries.push(entry);
    } catch {
      const error = new Error(`job log malformed: ${path}:${index + 1}`) as NodeJS.ErrnoException;
      error.code = "JOB_LOG_MALFORMED";
      throw error;
    }
  }
  return { entries, lineCount: lines.length };
}

async function defaultReadLogFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}
