// Portable product/reliability bounds. They are not sandbox security controls
// and do not claim CPU, memory, process-count, or descendant enforcement.
export const DEFAULT_JOB_WALL_CLOCK_LIMIT_MS = 30 * 60 * 1000;
export const DEFAULT_JOB_LOG_LIMIT_BYTES = 16 * 1024 * 1024;

export const JOB_WALL_CLOCK_LIMIT_EXCEEDED = "JOB_WALL_CLOCK_LIMIT_EXCEEDED";
export const JOB_LOG_LIMIT_EXCEEDED = "JOB_LOG_LIMIT_EXCEEDED";

export type JobLimitCode =
  | typeof JOB_WALL_CLOCK_LIMIT_EXCEEDED
  | typeof JOB_LOG_LIMIT_EXCEEDED;

export function jobLimitErrorMessage(code: JobLimitCode, limit: number): string {
  if (code === JOB_WALL_CLOCK_LIMIT_EXCEEDED) {
    return `${code}: Job exceeded the ${limit}ms wall-clock limit`;
  }
  return `${code}: persisted NDJSON log reached the ${limit}-byte limit`;
}

export function jobLogLineBytes(method: string, params: unknown): number {
  return Buffer.byteLength(`${JSON.stringify({ method, params })}\n`);
}
