import { isRecord } from "./objects.mts";

// Interim Job reports share the per-job append-only NDJSON log with
// `consult/update` and `consult/finalized` (ADR-0039). Every report line is a
// single JSON object written with one O_APPEND write, so concurrent writers
// interleave whole lines rather than corrupting each other.
export const REPORT_LOG_METHOD = "consult/report";

export const REPORT_TYPES: readonly string[] = Object.freeze([
  "blocked",
  "decision_needed",
  "discovery",
  "progress",
]);

// Bounds are enforced by the writer. Report lines bypass the Broker's persisted
// log accounting, so these caps are what keeps the worst-case addition to one
// Job's log bounded (~5 MiB).
export const MAX_REPORT_MESSAGE_BYTES = 4096;
export const MAX_REPORT_DATA_BYTES = 16 * 1024;
export const MAX_REPORTS_PER_JOB = 256;

// The marker is charged against the bound, so a stored message is never larger
// than MAX_REPORT_MESSAGE_BYTES.
export const REPORT_MESSAGE_TRUNCATED_MARKER = "\n[consult: report message truncated]";

export interface JobReportParams {
  jobId: string;
  at: string;
  type: string;
  message: string;
  data?: unknown;
}

export interface JobReportLogEntry {
  method: string;
  params: JobReportParams;
}

export function isReportType(value: unknown): boolean {
  return typeof value === "string" && REPORT_TYPES.includes(value);
}

export function boundReportMessage(message: string): string {
  if (Buffer.byteLength(message) <= MAX_REPORT_MESSAGE_BYTES) {
    return message;
  }
  const budget = MAX_REPORT_MESSAGE_BYTES - Buffer.byteLength(REPORT_MESSAGE_TRUNCATED_MARKER);
  return `${boundedUtf8(message, budget)}${REPORT_MESSAGE_TRUNCATED_MARKER}`;
}

export function jobReportLogEntry({
  jobId,
  at,
  type,
  message,
  data,
}: JobReportParams): JobReportLogEntry {
  return {
    method: REPORT_LOG_METHOD,
    params:
      data === undefined
        ? { jobId, at, type, message }
        : { jobId, at, type, message, data },
  };
}

// Report lines are written by delegated Jobs, so a parsed log entry is
// untrusted input: a line only counts as a report when it carries a known type
// and a string message.
export function reportParamsFromLogEntry(entry: unknown): JobReportParams | null {
  if (!isRecord(entry) || entry.method !== REPORT_LOG_METHOD) {
    return null;
  }
  const params = entry.params;
  if (!isRecord(params) || !isReportType(params.type) || typeof params.message !== "string") {
    return null;
  }
  return {
    jobId: typeof params.jobId === "string" ? params.jobId : "",
    at: typeof params.at === "string" ? params.at : "",
    type: params.type as string,
    message: params.message,
    ...(params.data === undefined ? {} : { data: params.data }),
  };
}

// `consult logs` renders one line per entry, so a multi-line report message is
// flattened rather than consuming several lines of the bounded tail window.
export function renderReportLogEntry(entry: unknown): string {
  const params = reportParamsFromLogEntry(entry);
  if (!params) {
    return "";
  }
  return `[report ${params.type}: ${params.message.replace(/\r?\n/gu, " ")}]\n`;
}

function boundedUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let text = "";
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    text += codePoint;
    bytes += codePointBytes;
  }
  return text;
}
