export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type NullOutputResult = CliResult;

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
