import type { CliResult, CodedError } from "./job-record-errors.mts";

export function workspaceOverrideErrorResult(error: unknown): CliResult | null {
  if ((error as CodedError).code !== "WORKSPACE_OVERRIDE_MALFORMED") {
    return null;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `workspace override malformed: ${(error as CodedError).path ?? "workspace override file"}\n`,
  };
}
