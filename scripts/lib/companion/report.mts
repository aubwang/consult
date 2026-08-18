import {
  invalidBooleanFlagValueError,
  missingFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { readJobLogEntries } from "../job-log-entries.mts";
import {
  appendJobLogLine,
  isFinalStatus,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import {
  MAX_REPORTS_PER_JOB,
  MAX_REPORT_DATA_BYTES,
  REPORT_TYPES,
  boundReportMessage,
  jobReportLogEntry,
  reportParamsFromLogEntry,
} from "../job-reports.mts";
import { workspaceRootResolver } from "./invocation-context.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import type { CommandResult } from "./output.mts";

const SUPPORTED_FLAGS = ["type", "data", "job", "message"];

export interface ReportDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  readLogFile?: (path: string) => Promise<string>;
  appendLogLine?: (workspaceRoot: string, jobId: string, entry: unknown) => Promise<void>;
  now?: () => string;
}

export interface RunReportOptions {
  args: ParsedArgs;
  env?: NodeJS.ProcessEnv;
  deps?: ReportDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runReport({ args: parsedArgs });
}

export async function runReport({
  args,
  env = process.env,
  deps = {},
}: RunReportOptions): Promise<CommandResult> {
  const usage = validateFlags(args);
  if (usage) {
    return usageError(usage);
  }
  const type = stringFlag(args.flags?.type);
  if (!type) {
    return usageError("--type is required");
  }
  if (!REPORT_TYPES.includes(type)) {
    return usageError(`unknown report type: ${type}; expected ${REPORT_TYPES.join(", ")}`);
  }
  const message = resolveMessage(args);
  if (!message) {
    return usageError("report message is required");
  }
  const data = resolveData(args);
  if ("error" in data) {
    return usageError(data.error);
  }
  // Inside a Job, CONSULT_PARENT_JOB is that Job's own id: the Broker injects it
  // so nested work can link itself to the Job it runs under.
  const jobId = stringFlag(args.flags?.job) ?? env.CONSULT_PARENT_JOB;
  if (!jobId) {
    return usageError(
      "job id is required: pass --job <job-id>, or run inside a Job so CONSULT_PARENT_JOB is set",
    );
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? workspaceRootResolver(env))();
  let record: JobRecord;
  try {
    record = await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }
  // The mirror of `result` before finalization: a report after finalization is
  // the same lifecycle-ordering violation, so it shares exit code 5.
  if (isFinalStatus(record.status)) {
    return {
      exitCode: 5,
      stdout: "",
      stderr: `job already finalized; cannot report (status=${record.status})\n`,
    };
  }

  let existingReports: number;
  try {
    existingReports = await countReports(workspaceRoot, jobId, deps);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
      return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
    }
    throw error;
  }
  if (existingReports >= MAX_REPORTS_PER_JOB) {
    return usageError(
      `job ${jobId} already holds ${existingReports} reports (limit ${MAX_REPORTS_PER_JOB})`,
    );
  }

  const now = deps.now ?? (() => new Date().toISOString());
  await (deps.appendLogLine ?? appendJobLogLine)(
    workspaceRoot,
    jobId,
    jobReportLogEntry({
      jobId,
      at: now(),
      type,
      message: boundReportMessage(message),
      data: data.value,
    }),
  );

  return { exitCode: 0, stdout: `reported ${type} for ${jobId}\n`, stderr: "" };
}

function validateFlags(args: ParsedArgs): string | null {
  return (
    unsupportedFlagError(args.flags, SUPPORTED_FLAGS) ??
    invalidBooleanFlagValueError(args.flags) ??
    missingFlagValueError(args.flags, SUPPORTED_FLAGS)
  );
}

function resolveMessage(args: ParsedArgs): string {
  return stringFlag(args.flags?.message) || (args.positional ?? []).join(" ").trim();
}

function resolveData(args: ParsedArgs): { value?: unknown } | { error: string } {
  const raw = stringFlag(args.flags?.data);
  if (raw === undefined) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "--data must be valid JSON" };
  }
  // JSON is rejected rather than truncated: a clipped payload is not parseable
  // by the reader that asked for structured data.
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
  if (bytes > MAX_REPORT_DATA_BYTES) {
    return { error: `--data is ${bytes} bytes; the limit is ${MAX_REPORT_DATA_BYTES}` };
  }
  return { value };
}

async function countReports(
  workspaceRoot: string,
  jobId: string,
  deps: ReportDeps,
): Promise<number> {
  const { entries } = await readJobLogEntries(workspaceRoot, jobId, {
    readLogFile: deps.readLogFile,
  });
  return entries.filter((entry) => reportParamsFromLogEntry(entry) !== null).length;
}

function usageError(message: string): CommandResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}
