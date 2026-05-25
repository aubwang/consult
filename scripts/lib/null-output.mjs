export function createNullOutput() {
  return {
    stdout() {},
    stderr() {},
    result(exitCode) {
      return { exitCode, stdout: "", stderr: "" };
    },
  };
}
