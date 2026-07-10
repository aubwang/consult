import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  startEgressProxy,
  type EgressDial,
  type EgressProxy,
  type EgressProxyOptions,
} from "./egress-proxy.mts";
import type { EgressLookup, PinnedEgressTarget } from "./egress-address-policy.mts";

const PUBLIC_V4 = "93.184.216.34";

test("starts authenticated random-port loopback listeners and pins an HTTP CONNECT", async () => {
  const harness = await startHarness({ trustedHosts: ["api.example.com"] });
  try {
    assert.match(harness.proxy.token, /^[0-9a-f]{64}$/u);
    assert.notEqual(harness.proxy.httpPort, harness.proxy.socksPort);

    const tunnel = await openHttpTunnel(
      harness.proxy,
      "API.Example.COM.:443",
    );
    assert.match(tunnel.header, /^HTTP\/1\.1 200 /u);
    tunnel.socket.write("ping");
    assert.equal((await tunnel.reader.readBytes(4)).toString(), "ping");
    tunnel.socket.destroy();

    assert.deepEqual(harness.lookups, ["api.example.com"]);
    assert.deepEqual(harness.dials, [
      {
        hostname: "api.example.com",
        port: 443,
        address: PUBLIC_V4,
        family: 4,
      },
    ]);
  } finally {
    await harness.proxy.close();
  }
});

test("HTTP listener rejects unauthenticated, incorrect, and non-CONNECT requests", async () => {
  const harness = await startHarness({ trustedHosts: ["api.example.com"] });
  try {
    const unauthenticated = await rawHttp(
      harness.proxy.httpPort,
      "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n",
    );
    assert.match(unauthenticated, /^HTTP\/1\.1 407 /u);

    const wrongAuth = basicAuth("consult", "wrong-token");
    const incorrect = await rawHttp(
      harness.proxy.httpPort,
      `CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: ${wrongAuth}\r\n\r\n`,
    );
    assert.match(incorrect, /^HTTP\/1\.1 407 /u);

    const plain = await rawHttp(
      harness.proxy.httpPort,
      "GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
    );
    assert.match(plain, /^HTTP\/1\.1 405 /u);
    assert.deepEqual(harness.lookups, []);
    assert.deepEqual(harness.dials, []);
  } finally {
    await harness.proxy.close();
  }
});

test("HTTP listener rejects disallowed hosts, wildcard apexes, and non-443 ports before DNS", async () => {
  const harness = await startHarness({ trustedHosts: ["*.trusted.example"] });
  try {
    for (const authority of [
      "trusted.example:443",
      "other.example:443",
      "child.trusted.example:80",
    ]) {
      const result = await rawHttpConnect(harness.proxy, authority);
      assert.match(result, /^HTTP\/1\.1 403 /u, authority);
    }
    assert.deepEqual(harness.lookups, []);

    const allowed = await openHttpTunnel(
      harness.proxy,
      "deep.child.trusted.example:443",
    );
    assert.match(allowed.header, /^HTTP\/1\.1 200 /u);
    allowed.socket.destroy();
    assert.deepEqual(harness.lookups, ["deep.child.trusted.example"]);
  } finally {
    await harness.proxy.close();
  }
});

test("allowPublicHosts permits public destinations but rejects mixed rebinding answers", async () => {
  const lookup: EgressLookup = async (hostname) =>
    hostname === "mixed.example"
      ? [
          { address: PUBLIC_V4, family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]
      : [{ address: PUBLIC_V4, family: 4 }];
  const harness = await startHarness({ allowPublicHosts: true }, lookup);
  try {
    const publicTunnel = await openHttpTunnel(
      harness.proxy,
      "public.example:443",
    );
    assert.match(publicTunnel.header, /^HTTP\/1\.1 200 /u);
    publicTunnel.socket.destroy();

    const mixed = await rawHttpConnect(harness.proxy, "mixed.example:443");
    assert.match(mixed, /^HTTP\/1\.1 403 /u);
    assert.equal(harness.dials.length, 1);
  } finally {
    await harness.proxy.close();
  }
});

test("SOCKS5 username/password CONNECT resolves and dials a pinned destination", async () => {
  const harness = await startHarness({ trustedHosts: ["api.example.com"] });
  try {
    const tunnel = await openSocksTunnel(harness.proxy, "api.example.com", 443);
    tunnel.socket.write("hello");
    assert.equal((await tunnel.reader.readBytes(5)).toString(), "hello");
    tunnel.socket.destroy();

    assert.deepEqual(harness.lookups, ["api.example.com"]);
    assert.equal(harness.dials[0].address, PUBLIC_V4);
  } finally {
    await harness.proxy.close();
  }
});

test("SOCKS listener rejects no-auth, incorrect credentials, and SOCKS4", async () => {
  const harness = await startHarness({ allowPublicHosts: true });
  try {
    const noAuth = await connectTcp(harness.proxy.socksPort);
    const noAuthReader = new SocketReader(noAuth);
    noAuth.write(Buffer.from([0x05, 0x01, 0x00]));
    assert.deepEqual(await noAuthReader.readBytes(2), Buffer.from([0x05, 0xff]));
    noAuth.destroy();

    const wrong = await connectTcp(harness.proxy.socksPort);
    const wrongReader = new SocketReader(wrong);
    wrong.write(Buffer.from([0x05, 0x01, 0x02]));
    assert.deepEqual(await wrongReader.readBytes(2), Buffer.from([0x05, 0x02]));
    wrong.write(authFrame("consult", "wrong-token"));
    assert.deepEqual(await wrongReader.readBytes(2), Buffer.from([0x01, 0x01]));
    wrong.destroy();

    const socks4 = await connectTcp(harness.proxy.socksPort);
    socks4.write(Buffer.from([0x04, 0x01, 0x01, 0xbb]));
    await waitForClose(socks4);
    assert.deepEqual(harness.lookups, []);
    assert.deepEqual(harness.dials, []);
  } finally {
    await harness.proxy.close();
  }
});

test("SOCKS listener rejects BIND, UDP, malformed frames, and non-443 CONNECT", async () => {
  const harness = await startHarness({ allowPublicHosts: true });
  try {
    for (const command of [0x02, 0x03]) {
      const { socket, reader } = await authenticateSocks(harness.proxy);
      socket.write(socksDomainRequest(command, "api.example.com", 443));
      assert.equal((await reader.readBytes(10))[1], 0x07);
      socket.destroy();
    }

    const non443 = await authenticateSocks(harness.proxy);
    non443.socket.write(socksDomainRequest(0x01, "api.example.com", 80));
    assert.equal((await non443.reader.readBytes(10))[1], 0x02);
    non443.socket.destroy();

    const malformed = await authenticateSocks(harness.proxy);
    malformed.socket.write(Buffer.from([0x05, 0x01, 0x01, 0x03, 0x00]));
    assert.equal((await malformed.reader.readBytes(10))[1], 0x01);
    malformed.socket.destroy();

    const oversized = await connectTcp(harness.proxy.socksPort);
    oversized.write(Buffer.alloc(3_000, 0x05));
    await waitForClose(oversized);
    assert.deepEqual(harness.lookups, []);
    assert.deepEqual(harness.dials, []);
  } finally {
    await harness.proxy.close();
  }
});

test("SOCKS listener rejects private literal destinations without DNS or dialing", async () => {
  const harness = await startHarness({ allowPublicHosts: true });
  try {
    const { socket, reader } = await authenticateSocks(harness.proxy);
    socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb]));
    assert.equal((await reader.readBytes(10))[1], 0x02);
    socket.destroy();
    assert.deepEqual(harness.lookups, []);
    assert.deepEqual(harness.dials, []);
  } finally {
    await harness.proxy.close();
  }
});

test("handshake, connect, and relay idle timeouts fail closed", async () => {
  const hangingDial: EgressDial = async () => new Promise(() => {});
  const proxy = await startEgressProxy(
    {
      allowPublicHosts: true,
      handshakeTimeoutMs: 30,
      connectTimeoutMs: 30,
      idleTimeoutMs: 30,
    },
    {
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      dial: hangingDial,
    },
  );
  try {
    const idleHandshake = await connectTcp(proxy.socksPort);
    await waitForClose(idleHandshake, 1_000);

    const dialTimeout = await rawHttpConnect(proxy, "public.example:443", 1_000);
    assert.match(dialTimeout, /^HTTP\/1\.1 502 /u);
  } finally {
    await proxy.close();
  }

  const relayHarness = await startHarness({
    allowPublicHosts: true,
    idleTimeoutMs: 30,
  });
  try {
    const tunnel = await openHttpTunnel(
      relayHarness.proxy,
      "public.example:443",
    );
    await waitForClose(tunnel.socket, 1_000);
  } finally {
    await relayHarness.proxy.close();
  }
});

test("close is idempotent and destroys active client and upstream streams", async () => {
  const harness = await startHarness({ allowPublicHosts: true });
  const tunnel = await openHttpTunnel(harness.proxy, "public.example:443");
  const upstream = harness.upstreams[0];

  await Promise.all([harness.proxy.close(), harness.proxy.close()]);
  await waitForClose(tunnel.socket);
  assert.equal(upstream.destroyed, true);
  await assert.rejects(connectTcp(harness.proxy.httpPort));
  await assert.rejects(connectTcp(harness.proxy.socksPort));
});

test("invalid trusted-host patterns and timeout values fail before listening", async () => {
  await assert.rejects(
    startEgressProxy({ trustedHosts: ["api.*.example"] }),
    /invalid trusted host pattern/u,
  );
  await assert.rejects(
    startEgressProxy({ trustedHosts: ["localhost"] }),
    /invalid egress hostname/u,
  );
  await assert.rejects(
    startEgressProxy({ handshakeTimeoutMs: 0 }),
    /positive integer/u,
  );
});

interface Harness {
  proxy: EgressProxy;
  lookups: string[];
  dials: PinnedEgressTarget[];
  upstreams: PassThrough[];
}

async function startHarness(
  options: EgressProxyOptions,
  lookupOverride?: EgressLookup,
): Promise<Harness> {
  const lookups: string[] = [];
  const dials: PinnedEgressTarget[] = [];
  const upstreams: PassThrough[] = [];
  const lookup: EgressLookup = async (hostname) => {
    lookups.push(hostname);
    return lookupOverride
      ? lookupOverride(hostname)
      : [{ address: PUBLIC_V4, family: 4 }];
  };
  const dial: EgressDial = async (target) => {
    dials.push(target);
    const upstream = new PassThrough();
    upstreams.push(upstream);
    return upstream;
  };
  const proxy = await startEgressProxy(options, { lookup, dial });
  return { proxy, lookups, dials, upstreams };
}

async function openHttpTunnel(
  proxy: EgressProxy,
  authority: string,
): Promise<{ socket: Socket; reader: SocketReader; header: string }> {
  const socket = await connectTcp(proxy.httpPort);
  const reader = new SocketReader(socket);
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\n` +
      `Host: ${authority}\r\n` +
      `Proxy-Authorization: ${basicAuth("consult", proxy.token)}\r\n\r\n`,
  );
  const header = (await reader.readUntil(Buffer.from("\r\n\r\n"))).toString();
  return { socket, reader, header };
}

async function rawHttpConnect(
  proxy: EgressProxy,
  authority: string,
  timeoutMs = 2_000,
): Promise<string> {
  return rawHttp(
    proxy.httpPort,
    `CONNECT ${authority} HTTP/1.1\r\n` +
      `Proxy-Authorization: ${basicAuth("consult", proxy.token)}\r\n\r\n`,
    timeoutMs,
  );
}

async function rawHttp(port: number, request: string, timeoutMs = 2_000): Promise<string> {
  const socket = await connectTcp(port);
  const reader = new SocketReader(socket);
  socket.write(request);
  try {
    return (await reader.readUntil(Buffer.from("\r\n\r\n"), timeoutMs)).toString();
  } finally {
    socket.destroy();
  }
}

async function openSocksTunnel(
  proxy: EgressProxy,
  hostname: string,
  port: number,
): Promise<{ socket: Socket; reader: SocketReader }> {
  const result = await authenticateSocks(proxy);
  result.socket.write(socksDomainRequest(0x01, hostname, port));
  const reply = await result.reader.readBytes(10);
  assert.equal(reply[1], 0x00);
  return result;
}

async function authenticateSocks(
  proxy: EgressProxy,
): Promise<{ socket: Socket; reader: SocketReader }> {
  const socket = await connectTcp(proxy.socksPort);
  const reader = new SocketReader(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  assert.deepEqual(await reader.readBytes(2), Buffer.from([0x05, 0x02]));
  socket.write(authFrame("consult", proxy.token));
  assert.deepEqual(await reader.readBytes(2), Buffer.from([0x01, 0x00]));
  return { socket, reader };
}

function authFrame(username: string, password: string): Buffer {
  const user = Buffer.from(username);
  const pass = Buffer.from(password);
  return Buffer.concat([
    Buffer.from([0x01, user.length]),
    user,
    Buffer.from([pass.length]),
    pass,
  ]);
}

function socksDomainRequest(command: number, hostname: string, port: number): Buffer {
  const host = Buffer.from(hostname);
  const suffix = Buffer.alloc(2);
  suffix.writeUInt16BE(port);
  return Buffer.concat([
    Buffer.from([0x05, command, 0x00, 0x03, host.length]),
    host,
    suffix,
  ]);
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function connectTcp(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitForClose(socket: Socket, timeoutMs = 2_000): Promise<void> {
  if (socket.destroyed) return;
  await withTestTimeout(once(socket, "close").then(() => undefined), timeoutMs);
}

class SocketReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly socket: Socket;
  private readonly waiters: Array<{
    take: (buffer: Buffer) => { value: Buffer; rest: Buffer } | null;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    socket.once("close", () => this.fail(new Error("socket closed before expected data")));
    socket.once("error", (error) => this.fail(error));
  }

  readBytes(length: number, timeoutMs = 2_000): Promise<Buffer> {
    return this.wait((buffer) =>
      buffer.length >= length
        ? { value: buffer.subarray(0, length), rest: buffer.subarray(length) }
        : null,
    timeoutMs);
  }

  readUntil(marker: Buffer, timeoutMs = 2_000): Promise<Buffer> {
    return this.wait((buffer) => {
      const index = buffer.indexOf(marker);
      if (index === -1) return null;
      const end = index + marker.length;
      return { value: buffer.subarray(0, end), rest: buffer.subarray(end) };
    }, timeoutMs);
  }

  private wait(
    take: (buffer: Buffer) => { value: Buffer; rest: Buffer } | null,
    timeoutMs: number,
  ): Promise<Buffer> {
    const immediate = take(this.buffer);
    if (immediate) {
      this.buffer = immediate.rest;
      return Promise.resolve(immediate.value);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        take,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for socket data"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      const result = waiter.take(this.buffer);
      if (!result) return;
      this.waiters.shift();
      clearTimeout(waiter.timer);
      this.buffer = result.rest;
      waiter.resolve(result.value);
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function withTestTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("test operation timed out")),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
