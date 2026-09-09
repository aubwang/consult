import assert from "node:assert/strict";
import { test } from "node:test";

test("ACP stream guard rejects a split oversized frame before decoding", async () => {
  const { boundedJsonlStream } = await import("./jsonl-framing.mts");
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from("12345"));
    controller.enqueue(Buffer.from("6789"));
    controller.close();
  } });
  const reader = source.pipeThrough(boundedJsonlStream(8)).getReader();
  assert.equal((await reader.read()).value?.length, 5);
  await assert.rejects(reader.read(), /exceeds 8 bytes/);
});
