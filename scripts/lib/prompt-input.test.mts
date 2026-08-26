import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import {
  MAX_PROMPT_INPUT_BYTES,
  readPromptSource,
  selectPromptSource,
} from "./prompt-input.mts";

test("selectPromptSource keeps --prompt ahead of positionals", () => {
  assert.deepEqual(
    selectPromptSource({ promptFlag: "from flag", positional: ["from", "positionals"] }),
    { source: { kind: "text", text: "from flag" } },
  );
});

test("selectPromptSource joins positionals into one prompt", () => {
  assert.deepEqual(selectPromptSource({ positional: ["fix", "the", "bug"] }), {
    source: { kind: "text", text: "fix the bug" },
  });
});

test("selectPromptSource reports no source when nothing carries a prompt", () => {
  assert.deepEqual(selectPromptSource({ positional: [] }), {});
  assert.deepEqual(selectPromptSource({ positional: ["   "] }), {});
});

test("selectPromptSource routes a dash to stdin on either flag", () => {
  assert.deepEqual(selectPromptSource({ promptFlag: "-" }), {
    source: { kind: "stdin", flag: "--prompt -" },
  });
  assert.deepEqual(selectPromptSource({ promptFileFlag: "-" }), {
    source: { kind: "stdin", flag: "--prompt-file -" },
  });
});

test("selectPromptSource routes a path to a file read", () => {
  assert.deepEqual(selectPromptSource({ promptFileFlag: "/tmp/prompt.md" }), {
    source: { kind: "file", path: "/tmp/prompt.md" },
  });
});

test("selectPromptSource rejects two prompt channels at once", () => {
  assert.equal(
    selectPromptSource({ promptFlag: "text", promptFileFlag: "prompt.md" }).error,
    "--prompt and --prompt-file are mutually exclusive",
  );
  assert.equal(
    selectPromptSource({ promptFileFlag: "prompt.md", positional: ["fix", "it"] }).error,
    "--prompt-file cannot be combined with a positional prompt after --",
  );
});

test("readPromptSource trims literal prompt text", async () => {
  assert.deepEqual(await readPromptSource({ kind: "text", text: "  review it \n" }), {
    prompt: "review it",
  });
});

test("readPromptSource rejects whitespace-only prompt text", async () => {
  assert.deepEqual(await readPromptSource({ kind: "text", text: "   " }), {
    error: "prompt is empty",
  });
});

test("readPromptSource reads a prompt file and trims the trailing newline", async (t) => {
  const filePath = await writePromptFile(t, "review scripts/lib/acp-client.mts\n");
  assert.deepEqual(await readPromptSource({ kind: "file", path: filePath }), {
    prompt: "review scripts/lib/acp-client.mts",
  });
});

test("readPromptSource preserves interior structure of a prompt file", async (t) => {
  const body = 'objective:\n  - keep "quotes" and $vars and `backticks` intact\n';
  const filePath = await writePromptFile(t, body);
  const result = await readPromptSource({ kind: "file", path: filePath });
  assert.equal(result.prompt, body.trimEnd());
});

test("readPromptSource reports a missing prompt file by path", async () => {
  const missing = path.join(os.tmpdir(), "consult-prompt-does-not-exist.md");
  assert.deepEqual(await readPromptSource({ kind: "file", path: missing }), {
    error: `prompt file not found: ${missing}`,
  });
});

test("readPromptSource rejects a directory given as a prompt file", async (t) => {
  const dir = await makeTempDir(t);
  assert.deepEqual(await readPromptSource({ kind: "file", path: dir }), {
    error: `prompt file is not a regular file: ${dir}`,
  });
});

test("readPromptSource rejects an empty prompt file", async (t) => {
  const filePath = await writePromptFile(t, "\n  \n");
  assert.deepEqual(await readPromptSource({ kind: "file", path: filePath }), {
    error: `prompt file ${filePath} is empty`,
  });
});

test("readPromptSource rejects a prompt file over the byte limit", async (t) => {
  const size = MAX_PROMPT_INPUT_BYTES + 1;
  const filePath = await writePromptFile(t, "x".repeat(size));
  assert.deepEqual(await readPromptSource({ kind: "file", path: filePath }), {
    error:
      `prompt file ${filePath} exceeds the ${MAX_PROMPT_INPUT_BYTES}-byte ` +
      `prompt limit (${size} bytes)`,
  });
});

test("readPromptSource rejects a binary prompt file", async (t) => {
  const filePath = path.join(await makeTempDir(t), "prompt.bin");
  await fs.writeFile(filePath, Buffer.from([0x68, 0x69, 0x00, 0x21]));
  assert.deepEqual(await readPromptSource({ kind: "file", path: filePath }), {
    error: `prompt file ${filePath} is not UTF-8 text`,
  });
});

test("readPromptSource reads stdin only through the injected reader", async () => {
  const result = await readPromptSource(
    { kind: "stdin", flag: "--prompt -" },
    { readStdin: () => chunks(["review ", "the diff\n"]) },
  );
  assert.deepEqual(result, { prompt: "review the diff" });
});

test("readPromptSource carries a prompt larger than a single argv argument", async () => {
  // 128 KiB is the Linux MAX_ARG_STRLEN wall that makes --prompt <text> fail.
  const body = "x".repeat(200 * 1024);
  const result = await readPromptSource(
    { kind: "stdin", flag: "--prompt -" },
    { readStdin: () => chunks([body]) },
  );
  assert.equal(result.prompt?.length, body.length);
});

test("readPromptSource stops reading stdin at the byte limit", async () => {
  let emitted = 0;
  async function* runaway() {
    while (true) {
      emitted += 1;
      yield Buffer.alloc(64 * 1024, 0x61);
    }
  }
  const result = await readPromptSource(
    { kind: "stdin", flag: "--prompt -" },
    { readStdin: () => runaway() },
  );
  assert.deepEqual(result, {
    error: `stdin prompt exceeds the ${MAX_PROMPT_INPUT_BYTES}-byte prompt limit`,
  });
  // Bounded rather than drained: the reader gives up once the limit is passed.
  assert.ok(emitted <= MAX_PROMPT_INPUT_BYTES / (64 * 1024) + 1, `read ${emitted} chunks`);
});

test("readPromptSource rejects empty stdin", async () => {
  assert.deepEqual(
    await readPromptSource(
      { kind: "stdin", flag: "--prompt -" },
      { readStdin: () => chunks(["\n"]) },
    ),
    { error: "stdin prompt is empty" },
  );
});

test("readPromptSource surfaces a stdin read failure", async () => {
  async function* failing() {
    yield Buffer.from("partial");
    throw new Error("stream closed");
  }
  assert.deepEqual(
    await readPromptSource({ kind: "stdin", flag: "--prompt -" }, { readStdin: () => failing() }),
    { error: "stdin prompt could not be read: stream closed" },
  );
});

async function* chunks(values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value, "utf8");
  }
}

async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-prompt-input-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writePromptFile(t: TestContext, body: string): Promise<string> {
  const filePath = path.join(await makeTempDir(t), "prompt.md");
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}
