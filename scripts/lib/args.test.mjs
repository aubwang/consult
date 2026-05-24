import assert from "node:assert/strict";
import { test } from "node:test";

import { BOOLEAN_FLAGS, parseArgs } from "./args.mjs";

test("parseArgs treats bare tokens as positional arguments", () => {
  assert.deepEqual(parseArgs(["a", "b", "c"]), {
    positional: ["a", "b", "c"],
    flags: {},
  });
});

test("parseArgs reads a flag value from the next token", () => {
  assert.deepEqual(parseArgs(["--name", "alice"]), {
    positional: [],
    flags: { name: "alice" },
  });
});

test("parseArgs leaves the prompt after read-only as positional", () => {
  assert.deepEqual(parseArgs(["--read-only", "create test.txt"]), {
    positional: ["create test.txt"],
    flags: { "read-only": true },
  });
});

for (const flagName of BOOLEAN_FLAGS) {
  test(`parseArgs leaves the following token positional after --${flagName}`, () => {
    assert.deepEqual(parseArgs([`--${flagName}`, "prompt text"]), {
      positional: ["prompt text"],
      flags: { [flagName]: true },
    });
  });
}

test("parseArgs still reads a value-consuming flag from the next token", () => {
  assert.deepEqual(parseArgs(["--agent", "codex", "prompt text"]), {
    positional: ["prompt text"],
    flags: { agent: "codex" },
  });
});

test("parseArgs reads a flag value after equals", () => {
  assert.deepEqual(parseArgs(["--name=alice"]), {
    positional: [],
    flags: { name: "alice" },
  });
});

test("parseArgs leaves equals-form boolean flag values unchanged", () => {
  assert.deepEqual(parseArgs(["--read-only=true", "prompt"]), {
    positional: ["prompt"],
    flags: { "read-only": "true" },
  });
});

test("parseArgs treats a flag without a value as true", () => {
  assert.deepEqual(parseArgs(["--verbose"]), {
    positional: [],
    flags: { verbose: true },
  });
});

test("parseArgs treats a no-prefixed flag as false", () => {
  assert.deepEqual(parseArgs(["--no-foo"]), {
    positional: [],
    flags: { foo: false },
  });
});

test("parseArgs leaves no-prefixed boolean flags unchanged", () => {
  assert.deepEqual(parseArgs(["--no-write", "prompt"]), {
    positional: ["prompt"],
    flags: { write: false },
  });
});

test("parseArgs promotes repeated flags to an array", () => {
  assert.deepEqual(parseArgs(["--tag", "a", "--tag", "b"]), {
    positional: [],
    flags: { tag: ["a", "b"] },
  });
});

test("parseArgs stops parsing flags after the separator", () => {
  assert.deepEqual(
    parseArgs(["delegate", "--write", "--prompt", "hello world", "--", "--literal-positional"]),
    {
      positional: ["delegate", "--literal-positional"],
      flags: { write: true, prompt: "hello world" },
    },
  );
});

test("parseArgs keeps separator arguments after earlier positionals", () => {
  assert.deepEqual(parseArgs(["foo", "--", "--bar"]), {
    positional: ["foo", "--bar"],
    flags: {},
  });
});

test("parseArgs still honors the separator after boolean flags", () => {
  assert.deepEqual(parseArgs(["--read-only", "--", "prompt"]), {
    positional: ["prompt"],
    flags: { "read-only": true },
  });
});
