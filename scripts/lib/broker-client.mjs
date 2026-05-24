import net from "node:net";

export async function connectBroker(socketPath, { connectTimeoutMs = 200 } = {}) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
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

export class BrokerClient {
  closed = false;

  #buffer = "";
  #closeHandlers = new Set();
  #handlers = new Map();
  #nextId = 1;
  #pending = new Map();
  #socket;

  constructor(socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("close", () => {
      this.closed = true;
      const error = brokerError("BROKER_DISCONNECTED", "Broker disconnected");
      this.#rejectPending(error);
      for (const handler of this.#closeHandlers) {
        handler(error);
      }
    });
  }

  async request(method, params, { timeoutMs } = {}) {
    if (this.closed) {
      throw brokerError("BROKER_CLOSED", "Broker client is closed");
    }

    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: undefined };
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

  on(method, handler) {
    this.#handlers.set(method, handler);
  }

  onClose(handler) {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async close() {
    if (this.closed) {
      return;
    }

    await new Promise((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.end();
    });
    this.closed = true;
  }

  #receive(chunk) {
    this.#buffer += chunk.toString("utf8");

    let newlineIndex;
    while ((newlineIndex = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line === "") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
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

  #handleMessage(message) {
    if (message.id == null) {
      this.#handlers.get(message.method)?.(message.params);
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }

    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(jsonRpcError(message.error));
      return;
    }

    pending.resolve(message.result);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function jsonRpcError(error) {
  const converted = new Error(error.message);
  converted.code = error.code;
  if ("data" in error) {
    converted.data = error.data;
  }
  return converted;
}

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
