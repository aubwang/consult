export function createOutput(deps) {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = deps.stdoutWrite ?? ((text) => process.stdout.write(text));
  const stderrWrite = deps.stderrWrite ?? ((text) => process.stderr.write(text));
  return {
    stdout(text) {
      stdout += text;
      stdoutWrite(text);
    },
    stderr(text) {
      stderr += text;
      stderrWrite(text);
    },
    result(exitCode) {
      return { exitCode, stdout, stderr };
    },
  };
}
