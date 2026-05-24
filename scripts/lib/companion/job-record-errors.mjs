export function jobRecordErrorResult(error) {
  if (error.code !== "JOB_RECORD_MALFORMED") {
    return null;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `job record malformed: ${error.path}\n`,
  };
}
