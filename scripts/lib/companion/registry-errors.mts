import type { CliResult, CodedError } from "./job-record-errors.mts";

export function registryErrorResult(error: CodedError): CliResult | null {
  if (error.code === "REGISTRY_MALFORMED") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `registry malformed: ${error.path}\n`,
    };
  }
  if (error.code === "REGISTRY_SCHEMA_MISMATCH") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `registry schema mismatch: ${error.path}\n`,
    };
  }
  return null;
}
