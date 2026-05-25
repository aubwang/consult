export const DEFAULT_MAX_JSONL_MESSAGE_BYTES = 1024 * 1024;

export function readJsonlMessages(buffer, chunk, { maxBytes = DEFAULT_MAX_JSONL_MESSAGE_BYTES } = {}) {
  const nextBuffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
  const lines = [];
  let remaining = nextBuffer;
  let newlineIndex;

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

function messageTooLarge(maxBytes) {
  const error = new Error(`JSON-RPC message exceeds ${maxBytes} bytes`);
  error.code = "MESSAGE_TOO_LARGE";
  return error;
}
