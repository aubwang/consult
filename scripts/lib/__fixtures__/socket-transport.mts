import { EventEmitter } from "node:events";
import net from "node:net";
import { after, type TestContext } from "node:test";

export type FakeConnectionHandler = (socket: net.Socket) => void;

const fakeServers = new Map<string, FakeConnectionHandler>();
let restoreCreateConnection: (() => void) | undefined;

after(() => {
  restoreCreateConnection?.();
});

export async function listenWithFallback(
  t: TestContext,
  server: net.Server,
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPERM") {
      throw error;
    }
    await closeServer(server);
    registerFakeServer(t, socketPath, server.listeners("connection")[0] as FakeConnectionHandler);
  });
}

export function registerFakeServer(
  t: TestContext,
  socketPath: string,
  onConnection: FakeConnectionHandler,
): void {
  installFakeNet();
  fakeServers.set(socketPath, onConnection);
  t.after(() => fakeServers.delete(socketPath));
}

function installFakeNet(): void {
  if (restoreCreateConnection) {
    return;
  }

  const realCreateConnection = net.createConnection;
  net.createConnection = ((socketPath: string) => {
    const onConnection = fakeServers.get(socketPath);
    const [clientSocket, serverSocket] = createSocketPair();
    queueMicrotask(() => {
      if (!onConnection) {
        const error: NodeJS.ErrnoException = new Error(`connect ENOENT ${socketPath}`);
        error.code = "ENOENT";
        clientSocket.emit("error", error);
        clientSocket.destroy();
        return;
      }
      onConnection(serverSocket as unknown as net.Socket);
      clientSocket.emit("connect");
    });
    return clientSocket;
  }) as unknown as typeof net.createConnection;
  restoreCreateConnection = () => {
    net.createConnection = realCreateConnection;
  };
}

function createSocketPair(): [FakeSocket, FakeSocket] {
  const first = new FakeSocket();
  const second = new FakeSocket();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  peer: FakeSocket | undefined;

  write(chunk: unknown, callback?: () => void): boolean {
    if (this.destroyed || !this.peer || this.peer.destroyed) {
      return false;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    queueMicrotask(() => {
      if (!this.peer!.destroyed) {
        this.peer!.emit("data", data);
      }
      callback?.();
    });
    return true;
  }

  end(): void {
    this.destroy();
  }

  destroy(): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    queueMicrotask(() => {
      this.emit("close");
      if (this.peer && !this.peer.destroyed) {
        this.peer.destroy();
      }
    });
    return this;
  }
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
