import assert from "node:assert/strict";
import { test } from "node:test";

import { createOutput } from "./output.mts";

test("createOutput captures and forwards stdout and stderr", () => {
  let forwardedStdout = "";
  let forwardedStderr = "";
  const output = createOutput({
    stdoutWrite: (text) => {
      forwardedStdout += text;
    },
    stderrWrite: (text) => {
      forwardedStderr += text;
    },
  });

  output.stdout("hello");
  output.stderr("oops");

  assert.deepEqual(output.result(7), {
    exitCode: 7,
    stdout: "hello",
    stderr: "oops",
  });
  assert.equal(forwardedStdout, "hello");
  assert.equal(forwardedStderr, "oops");
});
