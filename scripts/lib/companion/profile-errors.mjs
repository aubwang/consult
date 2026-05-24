export function profileErrorResult(error) {
  if (error.code === "PROFILES_MALFORMED") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `profiles malformed: ${error.path ?? "profiles file"}\n`,
    };
  }
  if (error.code === "PROFILES_SCHEMA_MISMATCH") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `profiles schema mismatch: ${error.path ?? "profiles file"}\n`,
    };
  }
  return null;
}
