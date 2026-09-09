export const DEFAULT_MAX_JSONL_MESSAGE_BYTES = 1024 * 1024;

// Bound each frame before the ACP SDK buffers/decodes it. Forward chunks with
// normal stream backpressure; a newline resets the budget, not the transport.
export function boundedJsonlStream(maxBytes = DEFAULT_MAX_JSONL_MESSAGE_BYTES): TransformStream<Uint8Array, Uint8Array> {
  let pendingBytes = 0;
  return new TransformStream({
    transform(chunk, controller) {
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index++) {
        if (chunk[index] !== 10) continue;
        if (pendingBytes + index - start > maxBytes) throw messageTooLarge(maxBytes);
        pendingBytes = 0;
        start = index + 1;
      }
      pendingBytes += chunk.byteLength - start;
      if (pendingBytes > maxBytes) throw messageTooLarge(maxBytes);
      controller.enqueue(chunk);
    },
  });
}

export interface JsonlFramingError extends Error {
  code: "MESSAGE_TOO_LARGE";
}

export interface ReadJsonlMessagesOptions {
  maxBytes?: number;
}

export interface JsonlReadResult {
  buffer: Buffer;
  lines: string[];
  error: JsonlFramingError | null;
}

export function readJsonlMessages(
  buffer: Buffer,
  chunk: Buffer,
  { maxBytes = DEFAULT_MAX_JSONL_MESSAGE_BYTES }: ReadJsonlMessagesOptions = {},
): JsonlReadResult {
  const nextBuffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
  const lines: string[] = [];
  let remaining = nextBuffer;
  let newlineIndex: number;

  while ((newlineIndex = remaining.indexOf(0x0a)) !== -1) {
    const line = remaining.subarray(0, newlineIndex);
    if (line.length > maxBytes) {
      return { buffer: Buffer.alloc(0), lines, error: messageTooLarge(maxBytes) };
    }
    lines.push(line.toString("utf8"));
    remaining = remaining.subarray(newlineIndex + 1);
  }

  if (remaining.length > maxBytes) {
    return { buffer: Buffer.alloc(0), lines, error: messageTooLarge(maxBytes) };
  }

  return { buffer: remaining, lines, error: null };
}

function messageTooLarge(maxBytes: number): JsonlFramingError {
  const error = new Error(`JSON-RPC message exceeds ${maxBytes} bytes`) as JsonlFramingError;
  error.code = "MESSAGE_TOO_LARGE";
  return error;
}
