import net from "node:net";

import { readJsonlMessages } from "./jsonl-framing.mts";

export interface BrokerError extends Error {
  code: string;
}

interface JsonRpcErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

interface JsonRpcErrorWithData extends Error {
  code: string;
  data?: unknown;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

export interface ConnectBrokerOptions {
  connectTimeoutMs?: number;
}

export async function connectBroker(
  socketPath: string,
  { connectTimeoutMs = 200 }: ConnectBrokerOptions = {},
): Promise<BrokerClient> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(brokerError("BROKER_UNREACHABLE", "Broker is unreachable"));
    }, connectTimeoutMs);

    socket.once("connect", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(brokerError("BROKER_UNREACHABLE", "Broker is unreachable"));
    });
  });

  return new BrokerClient(socket);
}

export interface RequestOptions {
  timeoutMs?: number;
}

export class BrokerClient {
  closed = false;

  #buffer: Buffer = Buffer.alloc(0);
  #closeHandlers = new Set<(error: BrokerError) => void>();
  #handlers = new Map<string, (params: unknown) => void>();
  #nextId = 1;
  #pending = new Map<number, PendingEntry>();
  #socket: net.Socket;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("close", () => {
      this.closed = true;
      const error = brokerError("BROKER_DISCONNECTED", "Broker disconnected");
      this.#rejectPending(error);
      for (const handler of this.#closeHandlers) {
        handler(error);
      }
    });
  }

  async request(method: string, params: unknown, { timeoutMs }: RequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      throw brokerError("BROKER_CLOSED", "Broker client is closed");
    }

    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const pending: PendingEntry = { resolve, reject, timeout: undefined };
      if (timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(brokerError("BROKER_TIMEOUT", "Broker request timed out"));
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
      this.#socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.#handlers.set(method, handler);
  }

  onClose(handler: (error: BrokerError) => void): () => void {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.end();
    });
    this.closed = true;
  }

  #receive(chunk: Buffer): void {
    const framed = readJsonlMessages(this.#buffer, chunk);
    this.#buffer = framed.buffer;
    if (framed.error) {
      const error = brokerError("BROKER_PROTOCOL_ERROR", framed.error.message);
      this.closed = true;
      this.#rejectPending(error);
      this.#socket.destroy();
      return;
    }

    for (const line of framed.lines) {
      if (line === "") {
        continue;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        const error = brokerError("BROKER_PROTOCOL_ERROR", "Broker sent malformed JSON");
        this.closed = true;
        this.#rejectPending(error);
        this.#socket.destroy();
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (message.id == null) {
      const handler = this.#handlers.get(message.method as string);
      handler?.(message.params);
      return;
    }

    const pending = this.#pending.get(message.id as number);
    if (!pending) {
      return;
    }

    this.#pending.delete(message.id as number);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(jsonRpcError(message.error as JsonRpcErrorPayload));
      return;
    }

    pending.resolve(message.result);
  }

  #rejectPending(error: BrokerError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function jsonRpcError(error: JsonRpcErrorPayload): JsonRpcErrorWithData {
  const converted = new Error(error.message) as JsonRpcErrorWithData;
  converted.code = error.code;
  if ("data" in error) {
    converted.data = error.data;
  }
  return converted;
}

function brokerError(code: string, message: string): BrokerError {
  const error = new Error(message) as BrokerError;
  error.code = code;
  return error;
}
