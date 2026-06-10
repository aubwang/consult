export interface NullOutputResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NullOutput {
  stdout(text: string): void;
  stderr(text: string): void;
  result(exitCode: number): NullOutputResult;
}

export function createNullOutput(): NullOutput {
  return {
    stdout() {},
    stderr() {},
    result(exitCode) {
      return { exitCode, stdout: "", stderr: "" };
    },
  };
}
