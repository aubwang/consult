import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { connectBroker, type BrokerError } from "./broker-client.mts";
import { listenWithFallback } from "./__fixtures__/socket-transport.mts";
import { DEFAULT_MAX_JSONL_MESSAGE_BYTES } from "./jsonl-framing.mts";

async function withBrokerServer(
  t: TestContext,
  onMessage: (message: Record<string, unknown>, socket: net.Socket) => void,
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".broker-client-"));
  const socketPath = path.join(dir, "broker.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          continue;
        }
        onMessage(JSON.parse(line) as Record<string, unknown>, socket);
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await listenWithFallback(t, server, socketPath);

  return socketPath;
}

function writeMessage(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

test("request resolves with the server reply payload", async (t) => {
  const socketPath = await withBrokerServer(t, (message, socket) => {
    if (message.method === "ping") {
      writeMessage(socket, { jsonrpc: "2.0", id: message.id, result: { pong: true } });
    }
  });
  const client = await connectBroker(socketPath);

  try {
    assert.deepEqual(await client.request("ping", {}), { pong: true });
  } finally {
    await client.close();
  }
});

test("request rejects when the server returns a JSON-RPC error", async (t) => {
  const socketPath = await withBrokerServer(t, (message, socket) => {
    writeMessage(socket, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: "BAD", message: "nope" },
    });
  });
  const client = await connectBroker(socketPath);

  try {
    await assert.rejects(client.request("fail", {}), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "BAD");
      assert.match((error as Error).message, /nope/);
      return true;
    });
  } finally {
    await client.close();
  }
});

test("request rejects with BROKER_TIMEOUT when the server never replies", async (t) => {
  const socketPath = await withBrokerServer(t, () => {});
  const client = await connectBroker(socketPath);

  try {
    await assert.rejects(client.request("hang", {}, { timeoutMs: 100 }), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "BROKER_TIMEOUT");
      return true;
    });
  } finally {
    await client.close();
  }
});

test(
  "request rejects with BROKER_DISCONNECTED when the server closes mid-request",
  { timeout: 500 },
  async (t) => {
    const socketPath = await withBrokerServer(t, (_message, socket) => {
      socket.destroy();
    });
    const client = await connectBroker(socketPath);

    await assert.rejects(client.request("drop", {}), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "BROKER_DISCONNECTED");
      return true;
    });
  },
);

test("request rejects with BROKER_PROTOCOL_ERROR when the server sends malformed JSON", async (t) => {
  const socketPath = await withBrokerServer(t, (_message, socket) => {
    socket.write("{\n");
  });
  const client = await connectBroker(socketPath);

  await assert.rejects(client.request("bad-json", {}), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "BROKER_PROTOCOL_ERROR");
    assert.match((error as Error).message, /malformed JSON/);
    return true;
  });
  assert.equal(client.closed, true);
});

test("request rejects with BROKER_PROTOCOL_ERROR when the server sends an oversized message", async (t) => {
  const socketPath = await withBrokerServer(t, (_message, socket) => {
    socket.write("x".repeat(DEFAULT_MAX_JSONL_MESSAGE_BYTES + 1));
  });
  const client = await connectBroker(socketPath);

  await assert.rejects(client.request("too-large", {}), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "BROKER_PROTOCOL_ERROR");
    assert.match((error as Error).message, /exceeds/);
    return true;
  });
  assert.equal(client.closed, true);
});

test("onClose observes broker disconnects", async (t) => {
  const socketPath = await withBrokerServer(t, (_message, socket) => {
    socket.destroy();
  });
  const client = await connectBroker(socketPath);
  const closed = new Promise<BrokerError>((resolve) => {
    client.onClose(resolve);
  });

  await assert.rejects(client.request("drop", {}), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "BROKER_DISCONNECTED");
    return true;
  });
  const error = await closed;
  assert.equal(error.code, "BROKER_DISCONNECTED");
});

test("routes server notifications to registered handlers", async (t) => {
  const socketPath = await withBrokerServer(t, (message, socket) => {
    writeMessage(socket, {
      jsonrpc: "2.0",
      method: "consult/update",
      params: { seq: 1 },
    });
    writeMessage(socket, { jsonrpc: "2.0", id: message.id, result: { ok: true } });
  });
  const client = await connectBroker(socketPath);
  const notification = new Promise((resolve) => {
    client.on("consult/update", resolve);
  });

  try {
    await client.request("start", {});
    assert.deepEqual(await notification, { seq: 1 });
  } finally {
    await client.close();
  }
});

test("connectBroker rejects with BROKER_UNREACHABLE when the socket path does not exist", async () => {
  const socketPath = path.join(process.cwd(), ".broker-client-missing.sock");

  await assert.rejects(connectBroker(socketPath, { connectTimeoutMs: 100 }), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "BROKER_UNREACHABLE");
    return true;
  });
});

test("request rejects with BROKER_CLOSED after close", { timeout: 500 }, async (t) => {
  const socketPath = await withBrokerServer(t, (message, socket) => {
    writeMessage(socket, { jsonrpc: "2.0", id: message.id, result: { ok: true } });
  });
  const client = await connectBroker(socketPath);

  await client.close();

  assert.equal(client.closed, true);
  // A closed client is terminal; callers must create a fresh connection explicitly.
  await assert.rejects(client.request("ping", {}), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "BROKER_CLOSED");
    return true;
  });
});

test("concurrent requests resolve with their own interleaved responses", async (t) => {
  let firstMessage: Record<string, unknown> | undefined;
  const socketPath = await withBrokerServer(t, (message, socket) => {
    if (message.method === "first") {
      firstMessage = message;
      return;
    }

    writeMessage(socket, { jsonrpc: "2.0", id: message.id, result: { order: "second" } });
    writeMessage(socket, {
      jsonrpc: "2.0",
      id: firstMessage!.id,
      result: { order: "first" },
    });
  });
  const client = await connectBroker(socketPath);

  try {
    const first = client.request("first", {});
    const second = client.request("second", {});

    assert.deepEqual(await Promise.all([first, second]), [
      { order: "first" },
      { order: "second" },
    ]);
  } finally {
    await client.close();
  }
});
