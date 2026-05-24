export function workspaceOverrideErrorResult(error) {
  if (error.code !== "WORKSPACE_OVERRIDE_MALFORMED") {
    return null;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `workspace override malformed: ${error.path ?? "workspace override file"}\n`,
  };
}
