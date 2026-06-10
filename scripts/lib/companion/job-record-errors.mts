export interface CodedError {
  code?: string;
  path?: string;
  message?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
