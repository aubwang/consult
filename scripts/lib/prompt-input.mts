import fs from "node:fs/promises";

// A prompt large enough to matter cannot travel through argv. Linux caps a
// single argument at 128 KiB (MAX_ARG_STRLEN) regardless of the ~2 MiB total,
// and macOS caps the whole argv+envp block near 1 MiB. execve rejects the
// oversize argument before bin/consult runs, so Consult can never turn that
// failure into an actionable message -- the only fix is a channel that is not
// argv. This limit bounds those channels instead; it sits at the ACP JSONL
// frame ceiling, which the prompt has to fit through anyway.
export const MAX_PROMPT_INPUT_BYTES = 1024 * 1024;

// `-` selects stdin for --prompt and --prompt-file alike, matching the usual
// CLI convention. Stdin is only ever read when a caller spells this out: an
// invocation that says nothing about stdin must not block waiting on input
// nobody meant to send.
export const STDIN_SOURCE_TOKEN = "-";

export type PromptSource =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string }
  | { kind: "stdin"; flag: string };

export interface PromptSourceInput {
  promptFlag?: string;
  promptFileFlag?: string;
  positional?: string[];
}

export interface SelectPromptSourceResult {
  source?: PromptSource;
  error?: string;
}

export interface ReadPromptSourceResult {
  prompt?: string;
  error?: string;
}

export interface PromptInputDeps {
  readStdin?: () => AsyncIterable<Uint8Array>;
}

// Decides which channel carries the prompt without touching the filesystem, so
// a malformed invocation fails before any Broker or Workspace work starts.
// A caller with no prompt at all gets an empty result rather than an error:
// each command phrases "prompt is required" in its own terms.
export function selectPromptSource({
  promptFlag,
  promptFileFlag,
  positional = [],
}: PromptSourceInput): SelectPromptSourceResult {
  const positionalPrompt = positional.join(" ").trim();

  if (promptFileFlag !== undefined && promptFlag !== undefined) {
    return { error: "--prompt and --prompt-file are mutually exclusive" };
  }
  if (promptFileFlag !== undefined && positionalPrompt) {
    return {
      error: "--prompt-file cannot be combined with a positional prompt after --",
    };
  }
  if (promptFileFlag !== undefined) {
    return promptFileFlag === STDIN_SOURCE_TOKEN
      ? { source: { kind: "stdin", flag: "--prompt-file -" } }
      : { source: { kind: "file", path: promptFileFlag } };
  }
  if (promptFlag === STDIN_SOURCE_TOKEN) {
    return { source: { kind: "stdin", flag: "--prompt -" } };
  }
  // A literal --prompt keeps winning over positionals, as it always has.
  if (promptFlag) {
    return { source: { kind: "text", text: promptFlag } };
  }
  if (positionalPrompt) {
    return { source: { kind: "text", text: positionalPrompt } };
  }
  return {};
}

export async function readPromptSource(
  source: PromptSource,
  deps: PromptInputDeps = {},
): Promise<ReadPromptSourceResult> {
  if (source.kind === "text") {
    const prompt = source.text.trim();
    return prompt ? { prompt } : { error: "prompt is empty" };
  }
  const read =
    source.kind === "file" ? await readPromptFile(source.path) : await readStdinPrompt(deps);
  if (read.error) return { error: read.error };

  const label = source.kind === "file" ? `prompt file ${source.path}` : "stdin prompt";
  const bytes = read.bytes as Buffer;
  // argv can never carry a NUL, so a caller that switched channels to send one
  // is passing a binary file by mistake. Decoding it would silently hand the
  // Profile replacement characters.
  if (bytes.includes(0)) {
    return { error: `${label} is not UTF-8 text` };
  }
  const prompt = bytes.toString("utf8").trim();
  return prompt ? { prompt } : { error: `${label} is empty` };
}

// The prompt file is read with Host authority at compose time, deliberately
// without Workspace confinement: reading a Host-private path here and handing
// the Job only the bounded text is exactly what a confined Job cannot do for
// itself.
async function readPromptFile(
  filePath: string,
): Promise<{ bytes?: Buffer; error?: string }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { error: `prompt file not found: ${filePath}` };
    }
    return {
      error: `prompt file could not be read: ${filePath}: ${(error as Error).message}`,
    };
  }
  if (!stat.isFile()) {
    return { error: `prompt file is not a regular file: ${filePath}` };
  }
  if (stat.size > MAX_PROMPT_INPUT_BYTES) {
    return { error: oversizeError(`prompt file ${filePath}`, stat.size) };
  }
  try {
    return { bytes: await fs.readFile(filePath) };
  } catch (error) {
    return {
      error: `prompt file could not be read: ${filePath}: ${(error as Error).message}`,
    };
  }
}

// Enforced while reading rather than after: a caller piping an unbounded stream
// must not be able to exhaust memory before the limit is checked.
async function readStdinPrompt(
  deps: PromptInputDeps,
): Promise<{ bytes?: Buffer; error?: string }> {
  const stream = (deps.readStdin ?? (() => process.stdin))();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_PROMPT_INPUT_BYTES) {
        // The true size is unknowable without draining the stream, so the
        // message states the limit rather than a partial count.
        return {
          error: `stdin prompt exceeds the ${MAX_PROMPT_INPUT_BYTES}-byte prompt limit`,
        };
      }
      chunks.push(buffer);
    }
  } catch (error) {
    return { error: `stdin prompt could not be read: ${(error as Error).message}` };
  }
  return { bytes: Buffer.concat(chunks) };
}

function oversizeError(label: string, size: number): string {
  return `${label} exceeds the ${MAX_PROMPT_INPUT_BYTES}-byte prompt limit (${size} bytes)`;
}
