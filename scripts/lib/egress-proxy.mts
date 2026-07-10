import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

import {
  normalizeEgressHostname,
  resolvePinnedEgressTarget,
  type EgressLookup,
  type PinnedEgressTarget,
} from "./egress-address-policy.mts";

const PROXY_USERNAME = "consult";
const HTTP_MAX_HEADER_BYTES = 16 * 1024;
const HTTP_MAX_TUNNEL_HEAD_BYTES = 64 * 1024;
const SOCKS_MAX_BUFFER_BYTES = 2 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type EgressDial = (
  target: PinnedEgressTarget,
  signal: AbortSignal,
) => Promise<Duplex>;

export interface EgressProxyDependencies {
  lookup?: EgressLookup;
  dial?: EgressDial;
}

export interface EgressProxyOptions {
  trustedHosts?: readonly string[];
  allowPublicHosts?: boolean;
  handshakeTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface EgressProxy {
  httpPort: number;
  socksPort: number;
  token: string;
  close(): Promise<void>;
}

interface HostPolicy {
  exact: Set<string>;
  wildcardBases: string[];
  allowPublicHosts: boolean;
}

interface ProxyRuntime {
  closing: boolean;
  clients: Set<Socket>;
  upstreams: Set<Duplex>;
  dialControllers: Set<AbortController>;
}

interface ProxyTimeouts {
  handshake: number;
  connect: number;
  idle: number;
}

class HostNotAllowedError extends Error {}

class OperationTimeoutError extends Error {}

export async function startEgressProxy(
  options: EgressProxyOptions = {},
  dependencies: EgressProxyDependencies = {},
): Promise<EgressProxy> {
  const hostPolicy = buildHostPolicy(
    options.trustedHosts ?? [],
    options.allowPublicHosts ?? false,
  );
  const timeouts: ProxyTimeouts = {
    handshake: validTimeout(
      "handshakeTimeoutMs",
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ),
    connect: validTimeout(
      "connectTimeoutMs",
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    idle: validTimeout(
      "idleTimeoutMs",
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ),
  };
  const lookup = dependencies.lookup ?? defaultLookup;
  const dial = dependencies.dial ?? defaultDial;
  const token = randomBytes(32).toString("hex");
  const expectedUsernameHash = authHash(Buffer.from(PROXY_USERNAME));
  const expectedTokenHash = authHash(Buffer.from(token));
  const runtime: ProxyRuntime = {
    closing: false,
    clients: new Set(),
    upstreams: new Set(),
    dialControllers: new Set(),
  };

  const authorize = async (hostname: string, port: number): Promise<PinnedEgressTarget> => {
    if (!Number.isInteger(port) || port !== 443) {
      throw new HostNotAllowedError("destination port is not allowed");
    }
    const normalized = normalizeEgressHostname(hostname);
    if (!hostAllowed(normalized, hostPolicy)) {
      throw new HostNotAllowedError("destination host is not allowed");
    }
    return withTimeout(
      resolvePinnedEgressTarget({ hostname: normalized, port }, lookup),
      timeouts.connect,
    );
  };

  const dialPinned = async (target: PinnedEgressTarget): Promise<Duplex> => {
    if (runtime.closing) {
      throw new Error("egress proxy is closing");
    }
    const controller = new AbortController();
    runtime.dialControllers.add(controller);
    let operation: Promise<Duplex> | undefined;
    try {
      operation = dial(target, controller.signal);
      const upstream = await withTimeout(
        operation,
        timeouts.connect,
        () => controller.abort(),
      );
      if (runtime.closing) {
        upstream.destroy();
        throw new Error("egress proxy is closing");
      }
      runtime.upstreams.add(upstream);
      upstream.once("close", () => runtime.upstreams.delete(upstream));
      return upstream;
    } catch (error) {
      controller.abort();
      void operation?.then((lateUpstream) => lateUpstream.destroy(), () => {});
      throw error;
    } finally {
      runtime.dialControllers.delete(controller);
    }
  };

  const authenticated = (authorization: string | undefined): boolean => {
    const credentials = parseBasicCredentials(authorization);
    if (credentials === null) return false;
    const usernameMatches = constantTimeMatches(
      credentials.username,
      expectedUsernameHash,
    );
    const tokenMatches = constantTimeMatches(credentials.password, expectedTokenHash);
    return usernameMatches && tokenMatches;
  };

  const httpServer = createHttpServer({ maxHeaderSize: HTTP_MAX_HEADER_BYTES });
  httpServer.headersTimeout = timeouts.handshake;
  httpServer.requestTimeout = timeouts.handshake;
  httpServer.keepAliveTimeout = timeouts.handshake;
  httpServer.setTimeout(timeouts.handshake, (socket) => socket.destroy());
  httpServer.on("connection", (socket) => trackClient(socket, runtime));
  httpServer.on("request", (_request, response) => {
    response.shouldKeepAlive = false;
    response.writeHead(405, {
      Allow: "CONNECT",
      Connection: "close",
      "Content-Type": "text/plain",
    });
    response.end("Only CONNECT is supported\n");
  });
  httpServer.on("upgrade", (_request, socket) => {
    writeHttpAndClose(socket as Socket, "405 Method Not Allowed", ["Allow: CONNECT"]);
  });
  httpServer.on("clientError", (_error, socket) => {
    writeHttpAndClose(socket as Socket, "400 Bad Request");
  });
  httpServer.on("connect", (request, client, head) => {
    void handleHttpConnect({
      request,
      client: client as Socket,
      head,
      authenticated,
      authorize,
      dialPinned,
      runtime,
      idleTimeoutMs: timeouts.idle,
    });
  });

  const socksServer = createNetServer((client) => {
    trackClient(client, runtime);
    handleSocksClient({
      client,
      expectedUsernameHash,
      expectedTokenHash,
      authorize,
      dialPinned,
      runtime,
      handshakeTimeoutMs: timeouts.handshake,
      idleTimeoutMs: timeouts.idle,
    });
  });

  try {
    const [httpPort, socksPort] = await Promise.all([
      listenLoopback(httpServer),
      listenLoopback(socksServer),
    ]);
    return {
      httpPort,
      socksPort,
      token,
      close: onceAsync(async () => {
        runtime.closing = true;
        for (const controller of runtime.dialControllers) {
          controller.abort();
        }
        runtime.dialControllers.clear();
        for (const client of runtime.clients) {
          client.destroy();
        }
        runtime.clients.clear();
        for (const upstream of runtime.upstreams) {
          upstream.destroy();
        }
        runtime.upstreams.clear();
        await Promise.all([closeServer(httpServer), closeServer(socksServer)]);
      }),
    };
  } catch (error) {
    runtime.closing = true;
    await Promise.all([closeServer(httpServer), closeServer(socksServer)]);
    throw error;
  }
}

interface HttpConnectContext {
  request: IncomingMessage;
  client: Socket;
  head: Buffer;
  authenticated: (authorization: string | undefined) => boolean;
  authorize: (hostname: string, port: number) => Promise<PinnedEgressTarget>;
  dialPinned: (target: PinnedEgressTarget) => Promise<Duplex>;
  runtime: ProxyRuntime;
  idleTimeoutMs: number;
}

async function handleHttpConnect(context: HttpConnectContext): Promise<void> {
  const { request, client, head } = context;
  client.pause();
  client.setTimeout(0);
  if (!context.authenticated(singleHeader(request.headers["proxy-authorization"]))) {
    writeHttpAndClose(client, "407 Proxy Authentication Required", [
      'Proxy-Authenticate: Basic realm="consult"',
    ]);
    return;
  }
  if (head.length > HTTP_MAX_TUNNEL_HEAD_BYTES) {
    writeHttpAndClose(client, "413 Content Too Large");
    return;
  }
  const target = parseConnectAuthority(request.url);
  if (!target) {
    writeHttpAndClose(client, "400 Bad Request");
    return;
  }

  let pinned: PinnedEgressTarget;
  try {
    pinned = await context.authorize(target.hostname, target.port);
  } catch {
    writeHttpAndClose(client, "403 Forbidden");
    return;
  }
  if (client.destroyed || context.runtime.closing) {
    client.destroy();
    return;
  }

  let upstream: Duplex;
  try {
    upstream = await context.dialPinned(pinned);
  } catch {
    writeHttpAndClose(client, "502 Bad Gateway");
    return;
  }
  if (client.destroyed || context.runtime.closing) {
    upstream.destroy();
    client.destroy();
    return;
  }

  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) {
    upstream.write(head);
  }
  beginRelay(client, upstream, context.idleTimeoutMs);
}

interface SocksClientContext {
  client: Socket;
  expectedUsernameHash: Buffer;
  expectedTokenHash: Buffer;
  authorize: (hostname: string, port: number) => Promise<PinnedEgressTarget>;
  dialPinned: (target: PinnedEgressTarget) => Promise<Duplex>;
  runtime: ProxyRuntime;
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
}

function handleSocksClient(context: SocksClientContext): void {
  const { client } = context;
  let state: "greeting" | "auth" | "request" | "resolving" = "greeting";
  let buffer = Buffer.alloc(0);
  const handshakeTimer = setTimeout(() => client.destroy(), context.handshakeTimeoutMs);
  handshakeTimer.unref();

  const onData = (chunk: Buffer): void => {
    if (state === "resolving") {
      return;
    }
    if (buffer.length + chunk.length > SOCKS_MAX_BUFFER_BYTES) {
      client.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);

    while (!client.destroyed) {
      if (state === "greeting") {
        if (buffer.length < 1) return;
        if (buffer[0] !== 0x05) {
          client.destroy();
          return;
        }
        if (buffer.length < 2) return;
        const methodCount = buffer[1];
        if (methodCount === 0) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        if (buffer.length < 2 + methodCount) return;
        const methods = buffer.subarray(2, 2 + methodCount);
        buffer = buffer.subarray(2 + methodCount);
        if (!methods.includes(0x02)) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        client.write(Buffer.from([0x05, 0x02]));
        state = "auth";
        continue;
      }

      if (state === "auth") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x01 || buffer[1] === 0) {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
        const usernameLength = buffer[1];
        if (buffer.length < 2 + usernameLength + 1) return;
        const passwordLength = buffer[2 + usernameLength];
        const frameLength = 3 + usernameLength + passwordLength;
        if (passwordLength === 0 || buffer.length < frameLength) return;
        const username = buffer.subarray(2, 2 + usernameLength);
        const password = buffer.subarray(3 + usernameLength, frameLength);
        buffer = buffer.subarray(frameLength);
        const usernameMatches = constantTimeMatches(
          username,
          context.expectedUsernameHash,
        );
        const tokenMatches = constantTimeMatches(password, context.expectedTokenHash);
        const accepted = usernameMatches && tokenMatches;
        if (!accepted) {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
        state = "request";
        continue;
      }

      if (state === "request") {
        const parsed = parseSocksRequest(buffer);
        if (parsed === null) return;
        if (parsed.type === "malformed") {
          client.end(socksReply(parsed.reply));
          return;
        }
        buffer = buffer.subarray(parsed.frameLength);
        const initialPayload = buffer;
        buffer = Buffer.alloc(0);
        state = "resolving";
        clearTimeout(handshakeTimer);
        client.pause();
        client.off("data", onData);
        void completeSocksConnect(context, parsed.hostname, parsed.port, initialPayload);
        return;
      }

      return;
    }
  };

  client.on("data", onData);
  client.once("close", () => clearTimeout(handshakeTimer));
}

async function completeSocksConnect(
  context: SocksClientContext,
  hostname: string,
  port: number,
  initialPayload: Buffer,
): Promise<void> {
  let pinned: PinnedEgressTarget;
  try {
    pinned = await context.authorize(hostname, port);
  } catch {
    context.client.end(socksReply(0x02));
    return;
  }
  if (context.client.destroyed || context.runtime.closing) {
    context.client.destroy();
    return;
  }

  let upstream: Duplex;
  try {
    upstream = await context.dialPinned(pinned);
  } catch {
    context.client.end(socksReply(0x05));
    return;
  }
  if (context.client.destroyed || context.runtime.closing) {
    upstream.destroy();
    context.client.destroy();
    return;
  }

  context.client.write(socksReply(0x00));
  if (initialPayload.length > 0) {
    upstream.write(initialPayload);
  }
  beginRelay(context.client, upstream, context.idleTimeoutMs);
}

type ParsedSocksRequest =
  | { type: "incomplete" }
  | { type: "malformed"; reply: number }
  | { type: "complete"; hostname: string; port: number; frameLength: number };

function parseSocksRequest(buffer: Buffer): Exclude<ParsedSocksRequest, { type: "incomplete" }> | null {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0x05 || buffer[2] !== 0x00) {
    return { type: "malformed", reply: 0x01 };
  }
  if (buffer[1] !== 0x01) {
    return { type: "malformed", reply: 0x07 };
  }

  const addressType = buffer[3];
  let hostname: string;
  let addressEnd: number;
  if (addressType === 0x01) {
    if (buffer.length < 10) return null;
    hostname = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
    addressEnd = 8;
  } else if (addressType === 0x04) {
    if (buffer.length < 22) return null;
    const groups = [];
    for (let offset = 4; offset < 20; offset += 2) {
      groups.push(buffer.readUInt16BE(offset).toString(16));
    }
    hostname = groups.join(":");
    addressEnd = 20;
  } else if (addressType === 0x03) {
    if (buffer.length < 5) return null;
    const hostnameLength = buffer[4];
    if (hostnameLength === 0) {
      return { type: "malformed", reply: 0x08 };
    }
    addressEnd = 5 + hostnameLength;
    if (buffer.length < addressEnd + 2) return null;
    try {
      hostname = UTF8_DECODER.decode(buffer.subarray(5, addressEnd));
    } catch {
      return { type: "malformed", reply: 0x08 };
    }
  } else {
    return { type: "malformed", reply: 0x08 };
  }

  const frameLength = addressEnd + 2;
  if (buffer.length < frameLength) return null;
  return {
    type: "complete",
    hostname,
    port: buffer.readUInt16BE(addressEnd),
    frameLength,
  };
}

function beginRelay(client: Socket, upstream: Duplex, idleTimeoutMs: number): void {
  const destroyPair = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.setTimeout(idleTimeoutMs, destroyPair);
  if ("setTimeout" in upstream && typeof upstream.setTimeout === "function") {
    upstream.setTimeout(idleTimeoutMs, destroyPair);
  }
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
}

function buildHostPolicy(trustedHosts: readonly string[], allowPublicHosts: boolean): HostPolicy {
  const exact = new Set<string>();
  const wildcardBases = [];
  for (const pattern of trustedHosts) {
    if (pattern.startsWith("*.")) {
      const base = normalizeEgressHostname(pattern.slice(2));
      wildcardBases.push(base);
      continue;
    }
    if (pattern.includes("*")) {
      throw new TypeError(`invalid trusted host pattern: ${JSON.stringify(pattern)}`);
    }
    exact.add(normalizeEgressHostname(pattern));
  }
  return { exact, wildcardBases, allowPublicHosts };
}

function hostAllowed(hostname: string, policy: HostPolicy): boolean {
  return (
    policy.allowPublicHosts ||
    policy.exact.has(hostname) ||
    policy.wildcardBases.some((base) => hostname.endsWith(`.${base}`))
  );
}

function parseConnectAuthority(authority: string | undefined): {
  hostname: string;
  port: number;
} | null {
  if (!authority) return null;
  const match = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(authority) ?? /^([^:[\]]+):(\d{1,5})$/u.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: match[1], port };
}

function parseBasicCredentials(
  authorization: string | undefined,
): { username: Buffer; password: Buffer } | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(authorization ?? "");
  if (!match || match[1].length % 4 !== 0) return null;
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.toString("base64") !== match[1]) return null;
  const separator = decoded.indexOf(0x3a);
  if (separator <= 0) return null;
  return {
    username: decoded.subarray(0, separator),
    password: decoded.subarray(separator + 1),
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function authHash(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function constantTimeMatches(actual: Buffer, expectedHash: Buffer): boolean {
  return timingSafeEqual(authHash(actual), expectedHash);
}

function socksReply(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function writeHttpAndClose(socket: Socket, status: string, headers: string[] = []): void {
  if (socket.destroyed) return;
  socket.end(
    [`HTTP/1.1 ${status}`, "Connection: close", ...headers, "", ""].join("\r\n"),
  );
}

function trackClient(client: Socket, runtime: ProxyRuntime): void {
  if (runtime.closing) {
    client.destroy();
    return;
  }
  runtime.clients.add(client);
  client.once("close", () => runtime.clients.delete(client));
  client.on("error", () => client.destroy());
}

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("proxy listener did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function validTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new OperationTimeoutError("proxy operation timed out"));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= action();
    return result;
  };
}

const defaultLookup: EgressLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new Error(`resolver returned unsupported address family: ${family}`);
    }
    return { address, family };
  });
};

const defaultDial: EgressDial = (target, signal) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({
      host: target.address,
      port: target.port,
      family: target.family,
      signal,
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
