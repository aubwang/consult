import type { CliResult, CodedError } from "./job-record-errors.mts";

export function profileErrorResult(error: unknown): CliResult | null {
  if ((error as CodedError).code === "PROFILES_MALFORMED") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `profiles malformed: ${(error as CodedError).path ?? "profiles file"}\n`,
    };
  }
  if ((error as CodedError).code === "PROFILES_SCHEMA_MISMATCH") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `profiles schema mismatch: ${(error as CodedError).path ?? "profiles file"}\n`,
    };
  }
  return null;
}
