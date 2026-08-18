import {
  boolFlag,
  invalidBooleanFlagValueError,
  missingFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { readJobLogEntries } from "../job-log-entries.mts";
import { isFinalStatus, readWorkspaceJobRecord } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { REPORT_TYPES, liveReportParams } from "../job-reports.mts";
import { workspaceRootResolver } from "./invocation-context.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import { pollUntilFinalRecord } from "./job-poll.mts";
import { createOutput } from "./output.mts";
import type { CommandResult, OutputDeps } from "./output.mts";

// The event stream is its own small versioned envelope: it is not a Job Result,
// so it does not reuse the schema-version-1 Job sections. Readers branch on
// schemaVersion and ignore unknown fields (ADR-0023).
export const EVENTS_SCHEMA_VERSION = 1;

export const LIFECYCLE_EVENT_TYPES: readonly string[] = Object.freeze([
  "queued",
  "running",
  "terminal",
]);

const EVENT_TYPES: readonly string[] = Object.freeze([
  ...REPORT_TYPES,
  ...LIFECYCLE_EVENT_TYPES,
]);

const SUPPORTED_FLAGS = ["follow", "json", "since", "type"];

export interface JobEvent {
  kind: string;
  type: string;
  at: string;
  seq?: number;
  message?: string;
  data?: unknown;
  status?: string;
  errorMessage?: string;
}

export interface EventsDeps extends OutputDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  readLogFile?: (path: string) => Promise<string>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

export interface RunEventsOptions {
  args: ParsedArgs;
  env?: NodeJS.ProcessEnv;
  deps?: EventsDeps;
}

interface EventFilter {
  since: number;
  type?: string;
}

interface FollowTimeoutError extends Error {
  code: string;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runEvents({ args: parsedArgs });
}

export async function runEvents({
  args,
  env = process.env,
  deps = {},
}: RunEventsOptions): Promise<CommandResult> {
  const usage =
    unsupportedFlagError(args.flags, SUPPORTED_FLAGS) ??
    invalidBooleanFlagValueError(args.flags) ??
    missingFlagValueError(args.flags, ["since", "type"]);
  if (usage) {
    return usageError(usage);
  }
  const jobId = args.positional?.[0];
  if (!jobId) {
    return usageError("job id is required");
  }
  const since = resolveSince(args);
  if (!since.ok) {
    return usageError(since.error);
  }
  const type = stringFlag(args.flags?.type);
  if (type !== undefined && !EVENT_TYPES.includes(type)) {
    return usageError(`unknown event type: ${type}; expected ${EVENT_TYPES.join(", ")}`);
  }
  const filter: EventFilter = { since: since.value, type };
  const follow = boolFlag(args.flags?.follow);
  const json = boolFlag(args.flags?.json);
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? workspaceRootResolver(env))();

  let record: JobRecord;
  try {
    record = await readJobRecord(workspaceRoot, jobId, deps);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }

  if (follow) {
    return await followEvents(workspaceRoot, jobId, filter, json, deps);
  }

  let events: JobEvent[];
  try {
    events = await readEvents(workspaceRoot, jobId, record, filter, deps);
  } catch (error) {
    return logReadErrorResult(error);
  }
  return {
    exitCode: 0,
    stdout: json
      ? `${JSON.stringify({ schemaVersion: EVENTS_SCHEMA_VERSION, jobId, events })}\n`
      : events.map((event) => renderEvent(event)).join(""),
    stderr: "",
  };
}

// Follow mode streams incrementally through the injected writers (defaulting to
// process stdout/stderr) and returns empty stdout/stderr; the caller must not
// print the result text again. --json streams NDJSON, one framed event per
// line, so a supervising process can parse each event as it arrives.
async function followEvents(
  workspaceRoot: string,
  jobId: string,
  filter: EventFilter,
  json: boolean,
  deps: EventsDeps,
): Promise<CommandResult> {
  const output = createOutput(deps);
  const emitted = new Set<string>();

  try {
    await pollUntilFinalRecord({
      readRecord: () => readJobRecord(workspaceRoot, jobId, deps),
      onRecord: async (record) => {
        const events = await readEvents(workspaceRoot, jobId, record, filter, deps, {
          dropPartialTail: true,
        });
        for (const event of events) {
          const key = eventKey(event);
          if (emitted.has(key)) {
            continue;
          }
          emitted.add(key);
          output.stdout(
            json
              ? `${JSON.stringify({ schemaVersion: EVENTS_SCHEMA_VERSION, jobId, event })}\n`
              : renderEvent(event),
          );
        }
      },
      maxWaitMs: deps.maxWaitMs,
      poll: deps.poll,
      nowMs: deps.nowMs,
      timeoutCode: "FOLLOW_TIMEOUT",
      timeoutMessage: `timed out following job ${jobId}`,
    });
  } catch (error) {
    if ((error as FollowTimeoutError).code === "FOLLOW_TIMEOUT") {
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

async function readEvents(
  workspaceRoot: string,
  jobId: string,
  record: JobRecord,
  filter: EventFilter,
  deps: EventsDeps,
  { dropPartialTail = false }: { dropPartialTail?: boolean } = {},
): Promise<JobEvent[]> {
  const { entries } = await readJobLogEntries(workspaceRoot, jobId, {
    readLogFile: deps.readLogFile,
    dropPartialTail,
  });
  return filterEvents(jobEvents(record, entries), filter);
}

// A Job only accepts reports while it is running, so file order places every
// admitted report between the running and terminal transitions. Deriving seq
// here rather than storing it keeps each append a single independent line, and
// liveReportParams drops any line that raced past finalization.
export function jobEvents(record: JobRecord, entries: readonly unknown[]): JobEvent[] {
  const events: JobEvent[] = [];
  if (typeof record.submittedAt === "string") {
    events.push({ kind: "lifecycle", type: "queued", at: record.submittedAt });
  }
  if (typeof record.startedAt === "string") {
    events.push({ kind: "lifecycle", type: "running", at: record.startedAt });
  }
  let seq = 0;
  for (const params of liveReportParams(entries)) {
    seq += 1;
    events.push({
      kind: "report",
      type: params.type,
      at: params.at,
      seq,
      message: params.message,
      ...("data" in params ? { data: params.data } : {}),
    });
  }
  if (isFinalStatus(record.status)) {
    events.push({
      kind: "lifecycle",
      type: "terminal",
      at: typeof record.completedAt === "string" ? record.completedAt : "",
      status: record.status as string,
      ...(typeof record.errorMessage === "string"
        ? { errorMessage: record.errorMessage }
        : {}),
    });
  }
  return events;
}

// --since addresses the report stream only; lifecycle transitions have no seq
// and are always replayed so a reconnecting reader still learns the Job ended.
function filterEvents(events: readonly JobEvent[], filter: EventFilter): JobEvent[] {
  return events.filter((event) => {
    if (filter.type !== undefined && event.type !== filter.type) {
      return false;
    }
    return event.seq === undefined || event.seq > filter.since;
  });
}

function eventKey(event: JobEvent): string {
  return event.seq === undefined ? `lifecycle:${event.type}` : `report:${event.seq}`;
}

function renderEvent(event: JobEvent): string {
  const at = event.at || "-";
  if (event.kind === "report") {
    const data = event.data === undefined ? "" : `    data: ${JSON.stringify(event.data)}\n`;
    return `[${at}] #${event.seq} ${event.type}: ${singleLine(event.message ?? "")}\n${data}`;
  }
  if (event.type === "terminal") {
    const error = event.errorMessage ? ` - ${singleLine(event.errorMessage)}` : "";
    return `[${at}] terminal: ${event.status ?? "unknown"}${error}\n`;
  }
  return `[${at}] ${event.type}\n`;
}

function singleLine(text: string): string {
  return text.replace(/\r?\n/gu, " ");
}

async function readJobRecord(
  workspaceRoot: string,
  jobId: string,
  deps: EventsDeps,
): Promise<JobRecord> {
  return await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
}

function resolveSince(
  args: ParsedArgs,
): { ok: true; value: number } | { ok: false; error: string } {
  if (args.flags?.since === undefined) {
    return { ok: true, value: 0 };
  }
  const raw = stringFlag(args.flags.since);
  const value = !raw ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, error: "--since must be a non-negative integer" };
  }
  return { ok: true, value };
}

function streamedResult(exitCode: number): CommandResult {
  return { exitCode, stdout: "", stderr: "" };
}

function logReadErrorResult(error: unknown): CommandResult {
  if ((error as NodeJS.ErrnoException).code === "JOB_LOG_MALFORMED") {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  throw error;
}

function usageError(message: string): CommandResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}
