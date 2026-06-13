import fs from "node:fs/promises";

import {
  isFinalStatus,
  jobLogPath,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { renderSessionUpdate } from "../session-update-renderer.mts";
import { createOutput } from "./output.mts";
import type { CommandResult, OutputDeps } from "./output.mts";
import { jobRecordErrorResult } from "./job-record-errors.mts";
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

async function followLogs(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
): Promise<CommandResult> {
  const output = createOutput({
    stdoutWrite: deps.stdoutWrite ?? (() => {}),
    stderrWrite: deps.stderrWrite ?? (() => {}),
  });
  const poll = deps.poll ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const deadline = nowMs() + (deps.maxWaitMs ?? 30 * 60 * 1000);
  let renderedLineCount = 0;
  let record: JobRecord;

  try {
    record = await readJobRecord(workspaceRoot, jobId, deps);
    renderedLineCount = await appendNewLogText(workspaceRoot, jobId, renderedLineCount, deps, output);
    while (!isFinalStatus(record.status)) {
      if (nowMs() >= deadline) {
        const error = new Error(`timed out following job ${jobId}`) as WaitTimeoutError;
        error.code = "FOLLOW_TIMEOUT";
        throw error;
      }
      await poll(200);
      record = await readJobRecord(workspaceRoot, jobId, deps);
      renderedLineCount = await appendNewLogText(
        workspaceRoot,
        jobId,
        renderedLineCount,
        deps,
        output,
      );
    }
  } catch (error) {
    if ((error as WaitTimeoutError).code === "FOLLOW_TIMEOUT") {
      output.stderr(`${(error as Error).message}\n`);
      return output.result(4);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      output.stderr(`job not found: ${jobId}\n`);
      return output.result(2);
    }
    const malformedRecord = jobRecordErrorResult(error);
    if (malformedRecord) {
      output.stderr(malformedRecord.stderr);
      return output.result(malformedRecord.exitCode);
    }
    const logError = logReadErrorResult(error);
    output.stderr(logError.stderr);
    return output.result(logError.exitCode);
  }

  return output.result(0);
}

async function appendNewLogText(
  workspaceRoot: string,
  jobId: string,
  renderedLineCount: number,
  deps: LogsDeps,
  output: { stdout(text: string): void },
): Promise<number> {
  const parsed = await readParsedLog(workspaceRoot, jobId, deps);
  output.stdout(renderLogEntries(parsed.entries.slice(renderedLineCount)));
  return parsed.entries.length;
}

async function readParsedLog(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
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
  return parseLog(contents, path);
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

function parseLog(contents: string, path: string): ParsedLog {
  const lines = contents.endsWith("\n") ? contents.slice(0, -1).split("\n") : contents.split("\n");
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

function jobLookupErrorResult(error: unknown, jobId: string): CommandResult {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return { exitCode: 2, stdout: "", stderr: `job not found: ${jobId}\n` };
  }
  const malformedResult = jobRecordErrorResult(error);
  if (malformedResult) {
    return malformedResult;
  }
  throw error;
}

function logReadErrorResult(error: unknown): CommandResult {
  if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  throw error;
}
