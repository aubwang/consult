import fs from "node:fs/promises";

import {
  jobLogPath,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { renderSessionUpdate } from "../session-update-renderer.mts";
import { createOutput } from "./output.mts";
import type { CommandResult, OutputDeps } from "./output.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import { pollUntilFinalRecord } from "./job-poll.mts";
import type { ParsedArgs } from "../args.mts";

export interface LogsDeps extends OutputDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  readLogFile?: (path: string) => Promise<string>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

interface ParsedLog {
  entries: unknown[];
  lineCount: number;
}

interface WaitTimeoutError extends Error {
  code: string;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runLogs({ args: parsedArgs });
}

export async function runLogs({
  args,
  deps = {},
}: {
  args: ParsedArgs;
  deps?: LogsDeps;
}): Promise<CommandResult> {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }
  if (args.flags?.follow && args.flags?.json) {
    return { exitCode: 2, stdout: "", stderr: "--json is not supported with --follow\n" };
  }

  try {
    await readJobRecord(workspaceRoot, jobId, deps);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }

  if (args.flags?.follow) {
    return await followLogs(workspaceRoot, jobId, deps);
  }

  let parsed: ParsedLog;
  try {
    parsed = await readParsedLog(workspaceRoot, jobId, deps);
  } catch (error) {
    return logReadErrorResult(error);
  }

  return {
    exitCode: 0,
    stdout: args.flags?.json
      ? `${JSON.stringify(parsed.entries)}\n`
      : renderLogEntries(parsed.entries),
    stderr: "",
  };
}

// Follow mode streams incrementally through the injected writers (defaulting
// to process stdout/stderr) and returns empty stdout/stderr; the caller must
// not print the result text again.
async function followLogs(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
): Promise<CommandResult> {
  const output = createOutput(deps);
  let renderedLineCount = 0;

  try {
    await pollUntilFinalRecord({
      readRecord: () => readJobRecord(workspaceRoot, jobId, deps),
      onRecord: async () => {
        renderedLineCount = await appendNewLogText(
          workspaceRoot,
          jobId,
          renderedLineCount,
          deps,
          output,
        );
      },
      maxWaitMs: deps.maxWaitMs,
      poll: deps.poll,
      nowMs: deps.nowMs,
      timeoutCode: "FOLLOW_TIMEOUT",
      timeoutMessage: `timed out following job ${jobId}`,
    });
  } catch (error) {
    if ((error as WaitTimeoutError).code === "FOLLOW_TIMEOUT") {
      output.stderr(`${(error as Error).message}\n`);
      return streamedResult(4);
    }
    if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
      output.stderr(`${(error as Error).message}\n`);
      return streamedResult(2);
    }
    const lookupResult = jobLookupErrorResult(error, jobId);
    output.stderr(lookupResult.stderr);
    return streamedResult(lookupResult.exitCode);
  }

  return streamedResult(0);
}

function streamedResult(exitCode: number): CommandResult {
  return { exitCode, stdout: "", stderr: "" };
}

async function appendNewLogText(
  workspaceRoot: string,
  jobId: string,
  renderedLineCount: number,
  deps: LogsDeps,
  output: { stdout(text: string): void },
): Promise<number> {
  const parsed = await readParsedLog(workspaceRoot, jobId, deps, { dropPartialTail: true });
  output.stdout(renderLogEntries(parsed.entries.slice(renderedLineCount)));
  return parsed.entries.length;
}

async function readParsedLog(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
  { dropPartialTail = false }: { dropPartialTail?: boolean } = {},
): Promise<ParsedLog> {
  let contents: string;
  const path = jobLogPath(workspaceRoot, jobId);
  try {
    contents = await (deps.readLogFile ?? defaultReadLogFile)(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], lineCount: 0 };
    }
    throw error;
  }
  return parseLog(contents, path, { dropPartialTail });
}

async function readJobRecord(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
): Promise<JobRecord> {
  return await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
}

async function defaultReadLogFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}

function parseLog(
  contents: string,
  path: string,
  { dropPartialTail = false }: { dropPartialTail?: boolean } = {},
): ParsedLog {
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
      entries.push(JSON.parse(line));
    } catch {
      const error = new Error(`job log malformed: ${path}:${index + 1}`) as NodeJS.ErrnoException;
      error.code = "JOB_LOG_MALFORMED";
      throw error;
    }
  }
  return { entries, lineCount: lines.length };
}

function renderLogEntries(entries: unknown[]): string {
  return entries.map((entry) => renderLogEntry(entry)).join("");
}

function renderLogEntry(entry: unknown): string {
  const method = (entry as { method?: unknown }).method;
  if (method === "consult/update") {
    return renderSessionUpdate((entry as { params?: unknown }).params as never);
  }
  return renderSessionUpdate(entry as never);
}

function logReadErrorResult(error: unknown): CommandResult {
  if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  throw error;
}
