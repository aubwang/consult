import fs from "node:fs/promises";

import { jobLogPath } from "./job-records.mts";
import { isRecord } from "./objects.mts";

const FINALIZED_LOG_METHOD = "consult/finalized";

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
  { dropPartialTail = false, lineOffset = 0 }: { dropPartialTail?: boolean; lineOffset?: number } = {},
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
      const error = new Error(`job log malformed: ${path}:${lineOffset + index + 1}`) as NodeJS.ErrnoException;
      error.code = "JOB_LOG_MALFORMED";
      throw error;
    }
  }
  return { entries, lineCount: lines.length };
}

export function createJobLogCursor(filePath: string): { read: (final?: boolean) => Promise<ParsedJobLog> } {
  let offset = 0;
  let lineOffset = 0;
  let identity: string | undefined;
  let pending = Buffer.alloc(0);
  return { async read(final = false) {
    const file = await fs.open(filePath, "r").catch((error) => {
      if (error.code === "ENOENT" && offset === 0) return null;
      throw error;
    });
    if (!file) return { entries: [], lineCount: 0 };
    const entries: unknown[] = [];
    const startingLine = lineOffset;
    try {
      const stat = await file.stat();
      const nextIdentity = `${stat.dev}:${stat.ino}`;
      if ((identity && identity !== nextIdentity) || stat.size < offset) {
        throw Object.assign(new Error(`job log replaced or truncated while following: ${filePath}`), { code: "JOB_LOG_MALFORMED" });
      }
      identity = nextIdentity;
      while (offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        const end = pending.lastIndexOf(10) + 1;
        if (end > 0) {
          const parsed = parseJobLog(pending.subarray(0, end).toString("utf8"), filePath, { lineOffset });
          entries.push(...parsed.entries);
          lineOffset += parsed.lineCount;
          pending = Buffer.from(pending.subarray(end));
        }
        if (pending.length > 2 * 1024 * 1024) {
          throw Object.assign(new Error(`job log frame exceeds 2 MiB: ${filePath}:${lineOffset + 1}`), { code: "JOB_LOG_MALFORMED" });
        }
      }
      if (final && pending.length) {
        throw Object.assign(new Error(`job log has an incomplete final line: ${filePath}:${lineOffset + 1}`), { code: "JOB_LOG_MALFORMED" });
      }
      return { entries, lineCount: lineOffset - startingLine };
    } finally { await file.close(); }
  } };
}

// A Job's derived event stream ends where its finalization line does. The log
// is multi-writer by design, so a line can land after `consult/finalized`;
// voiding those at read time is what makes the derived stream deterministic,
// rather than any check a writer could perform (ADR-0039). Reports and steers
// share this window, so they share one place that defines it.
export function liveJobLogEntries(entries: readonly unknown[]): unknown[] {
  const live: unknown[] = [];
  for (const entry of entries) {
    if (isRecord(entry) && entry.method === FINALIZED_LOG_METHOD) {
      break;
    }
    live.push(entry);
  }
  return live;
}

async function defaultReadLogFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}
