export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OutputDeps {
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
}

export interface OutputHandle {
  stdout(text: string): void;
  stderr(text: string): void;
  result(exitCode: number): CommandResult;
}

export function createOutput(deps: OutputDeps): OutputHandle {
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
