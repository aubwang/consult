import type { CliResult } from "../null-output.mts";

export type { CliResult } from "../null-output.mts";

export interface CodedError {
  code?: string;
  path?: string;
  message?: string;
}

export function jobRecordErrorResult(error: unknown): CliResult | null {
  if ((error as CodedError).code !== "JOB_RECORD_MALFORMED") {
    return null;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `job record malformed: ${(error as CodedError).path}\n`,
  };
}

export function jobLookupErrorResult(
  error: unknown,
  jobId: string,
  label = "job not found",
): CliResult {
  if ((error as CodedError).code === "ENOENT") {
    return { exitCode: 2, stdout: "", stderr: `${label}: ${jobId}\n` };
  }
  const malformedResult = jobRecordErrorResult(error);
  if (malformedResult) {
    return malformedResult;
  }
  throw error;
}
