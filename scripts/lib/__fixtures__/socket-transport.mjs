import { EventEmitter } from "node:events";
import net from "node:net";
import { after } from "node:test";

const fakeServers = new Map();
let restoreCreateConnection;

after(() => {
  restoreCreateConnection?.();
});

export async function listenWithFallback(t, server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  }).catch(async (error) => {
    if (error.code !== "EPERM") {
      throw error;
    }
    await closeServer(server);
    registerFakeServer(t, socketPath, server.listeners("connection")[0]);
  });
}

export function registerFakeServer(t, socketPath, onConnection) {
  installFakeNet();
  fakeServers.set(socketPath, onConnection);
  t.after(() => fakeServers.delete(socketPath));
}

function installFakeNet() {
  if (restoreCreateConnection) {
    return;
  }

  const realCreateConnection = net.createConnection;
  net.createConnection = (socketPath) => {
    const onConnection = fakeServers.get(socketPath);
    const [clientSocket, serverSocket] = createSocketPair();
    queueMicrotask(() => {
      if (!onConnection) {
        const error = new Error(`connect ENOENT ${socketPath}`);
        error.code = "ENOENT";
        clientSocket.emit("error", error);
        clientSocket.destroy();
        return;
      }
      onConnection(serverSocket);
      clientSocket.emit("connect");
    });
    return clientSocket;
  };
  restoreCreateConnection = () => {
    net.createConnection = realCreateConnection;
  };
}

function createSocketPair() {
  const first = new FakeSocket();
  const second = new FakeSocket();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  peer;

  write(chunk, callback) {
    if (this.destroyed || !this.peer || this.peer.destroyed) {
      return false;
    }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    queueMicrotask(() => {
      if (!this.peer.destroyed) {
        this.peer.emit("data", data);
      }
      callback?.();
    });
    return true;
  }

  end() {
    this.destroy();
  }

  destroy() {
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

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}
