import { readWorkspaceJobRecord } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { readJobLogEntries } from "../job-log-entries.mts";
import type { ParsedJobLog } from "../job-log-entries.mts";
import { REPORT_LOG_METHOD, renderReportLogEntry } from "../job-reports.mts";
import { STEER_LOG_METHOD, renderSteerLogEntry } from "../job-steer.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { renderSessionUpdate } from "../session-update-renderer.mts";
import { createOutput } from "./output.mts";
import type { CommandResult, OutputDeps } from "./output.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import { pollUntilFinalRecord } from "./job-poll.mts";
import {
  boolFlag,
  invalidBooleanFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";

const DEFAULT_LOG_TAIL_LINES = 20;

export interface LogsDeps extends OutputDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  readLogFile?: (path: string) => Promise<string>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
  nowMs?: () => number;
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
  const unsupported = unsupportedFlagError(args.flags, ["follow", "json", "tail", "all"]);
  if (unsupported) {
    return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  }
  const invalidBoolean = invalidBooleanFlagValueError(args.flags);
  if (invalidBoolean) {
    return { exitCode: 2, stdout: "", stderr: `${invalidBoolean}\n` };
  }
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }
  const follow = boolFlag(args.flags?.follow);
  const json = boolFlag(args.flags?.json);
  if (follow && json) {
    return { exitCode: 2, stdout: "", stderr: "--json is not supported with --follow\n" };
  }
  const tail = resolveTailLines(args);
  if (!tail.ok) {
    return { exitCode: 2, stdout: "", stderr: `${tail.error}\n` };
  }
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();

  try {
    await readJobRecord(workspaceRoot, jobId, deps);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }

  if (follow) {
    return await followLogs(workspaceRoot, jobId, tail.value, deps);
  }

  let parsed: ParsedJobLog;
  try {
    parsed = await readParsedLog(workspaceRoot, jobId, deps);
  } catch (error) {
    return logReadErrorResult(error);
  }

  return {
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify(tailEntries(parsed.entries, tail.value))}\n`
      : tailRenderedText(renderLogEntries(parsed.entries), tail.value),
    stderr: "",
  };
}

// Follow mode streams incrementally through the injected writers (defaulting
// to process stdout/stderr) and returns empty stdout/stderr; the caller must
// not print the result text again.
async function followLogs(
  workspaceRoot: string,
  jobId: string,
  tailLines: number | null,
  deps: LogsDeps,
): Promise<CommandResult> {
  const output = createOutput(deps);
  let renderedLineCount = 0;

  try {
    const initial = await readParsedLog(workspaceRoot, jobId, deps, { dropPartialTail: true });
    const initialText = tailRenderedText(renderLogEntries(initial.entries), tailLines);
    if (initialText) output.stdout(initialText);
    renderedLineCount = initial.entries.length;
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
  const newText = renderLogEntries(parsed.entries.slice(renderedLineCount));
  if (newText) output.stdout(newText);
  return parsed.entries.length;
}

async function readParsedLog(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
  { dropPartialTail = false }: { dropPartialTail?: boolean } = {},
): Promise<ParsedJobLog> {
  return await readJobLogEntries(workspaceRoot, jobId, {
    readLogFile: deps.readLogFile,
    dropPartialTail,
  });
}

async function readJobRecord(
  workspaceRoot: string,
  jobId: string,
  deps: LogsDeps,
): Promise<JobRecord> {
  return await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
}

function renderLogEntries(entries: unknown[]): string {
  return entries.map((entry) => renderLogEntry(entry)).join("");
}

function renderLogEntry(entry: unknown): string {
  const method = (entry as { method?: unknown }).method;
  if (method === "consult/update") {
    return renderSessionUpdate((entry as { params?: unknown }).params as never);
  }
  // Interim reports are written by the Job itself, not by the ACP session, so
  // they get their own rendering instead of falling through to the session
  // update renderer (which would silently drop them).
  if (method === REPORT_LOG_METHOD) {
    return renderReportLogEntry(entry);
  }
  // Steer lines are supervisor guidance delivered into the turn, not ACP
  // session output, so they render as their own transcript line.
  if (method === STEER_LOG_METHOD) {
    return renderSteerLogEntry(entry);
  }
  return renderSessionUpdate(entry as never);
}

function resolveTailLines(args: ParsedArgs):
  | { ok: true; value: number | null }
  | { ok: false; error: string } {
  if (boolFlag(args.flags?.all)) {
    if (args.flags?.tail !== undefined) {
      return { ok: false, error: "--all and --tail are mutually exclusive" };
    }
    return { ok: true, value: null };
  }
  if (args.flags?.tail === undefined) {
    return { ok: true, value: DEFAULT_LOG_TAIL_LINES };
  }
  const raw = stringFlag(args.flags.tail);
  const value = !raw ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: "--tail must be a non-negative integer" };
  }
  return { ok: true, value };
}

function tailRenderedText(text: string, lineCount: number | null): string {
  if (lineCount === null || text === "") return text;
  if (lineCount === 0) return "";
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const tailed = lines.slice(-lineCount).join("\n");
  return endsWithNewline ? `${tailed}\n` : tailed;
}

function tailEntries(entries: unknown[], lineCount: number | null): unknown[] {
  if (lineCount === null) return entries;
  if (lineCount === 0) return [];
  return entries.slice(-lineCount);
}

function logReadErrorResult(error: unknown): CommandResult {
  if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  throw error;
}
