import { isRecord } from "./objects.mts";

// Mid-Job steering shares the per-job append-only NDJSON log with
// `consult/update`, `consult/finalized`, and `consult/report` (ADR-0040). The
// Broker records one line per accepted steer, so the guidance a Job was given
// mid-turn survives in the same transcript as the turn it interrupted.
export const STEER_LOG_METHOD = "consult/steer";

// Guidance is rejected rather than truncated: a clipped instruction changes
// what the Job is being told to do, which is worse than refusing the steer.
export const MAX_STEER_GUIDANCE_BYTES = 16 * 1024;

// Event and transcript renderings carry a bounded preview, not the whole
// 16 KiB: the full guidance is already one line up in the raw log.
export const STEER_PREVIEW_CHARS = 200;

const PREVIEW_TRUNCATED_MARKER = "...";

const GUIDANCE_START = "--- BEGIN CONSULT SUPERVISOR GUIDANCE ---";
const GUIDANCE_END = "--- END CONSULT SUPERVISOR GUIDANCE ---";
const CONTINUE_INSTRUCTION =
  "The previous turn was stopped only to deliver this guidance. Continue the " +
  "original task from where it stopped, incorporating the guidance above.";

export interface JobSteerParams {
  jobId: string;
  at: string;
  guidance: string;
}

export interface JobSteerLogEntry {
  method: string;
  params: JobSteerParams;
}

export function jobSteerLogEntry({ jobId, at, guidance }: JobSteerParams): JobSteerLogEntry {
  return { method: STEER_LOG_METHOD, params: { jobId, at, guidance } };
}

// Unlike a Job Result or an upstream dependency's output, guidance comes from
// the supervisor that owns the Job, so it is framed as instructions rather than
// fenced off as untrusted data. The delimiters exist so the Profile can tell
// the interjection apart from its original task.
export function steerGuidancePrompt(guidance: string): string {
  return `${GUIDANCE_START}\n${guidance}\n${GUIDANCE_END}\n${CONTINUE_INSTRUCTION}`;
}

// A steer line is written by the Broker, but the log is multi-writer by design,
// so a parsed entry is still validated before it becomes an event.
export function steerParamsFromLogEntry(entry: unknown): JobSteerParams | null {
  if (!isRecord(entry) || entry.method !== STEER_LOG_METHOD) {
    return null;
  }
  const params = entry.params;
  if (!isRecord(params) || typeof params.guidance !== "string") {
    return null;
  }
  return {
    jobId: typeof params.jobId === "string" ? params.jobId : "",
    at: typeof params.at === "string" ? params.at : "",
    guidance: params.guidance,
  };
}

export function steerGuidancePreview(guidance: string): string {
  const singleLine = guidance.replace(/\r?\n/gu, " ");
  if (singleLine.length <= STEER_PREVIEW_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, STEER_PREVIEW_CHARS - PREVIEW_TRUNCATED_MARKER.length)}${PREVIEW_TRUNCATED_MARKER}`;
}

// `consult logs` renders one line per entry, so the guidance is previewed on a
// single line rather than consuming the bounded tail window.
export function renderSteerLogEntry(entry: unknown): string {
  const params = steerParamsFromLogEntry(entry);
  if (!params) {
    return "";
  }
  return `[steer: ${steerGuidancePreview(params.guidance)}]\n`;
}
