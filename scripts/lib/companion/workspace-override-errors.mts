import type { CliResult, CodedError } from "./job-record-errors.mts";

export function workspaceOverrideErrorResult(error: CodedError): CliResult | null {
  if (error.code !== "WORKSPACE_OVERRIDE_MALFORMED") {
    return null;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `workspace override malformed: ${error.path ?? "workspace override file"}\n`,
  };
}
