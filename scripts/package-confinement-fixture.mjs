#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const config = JSON.parse(process.argv[2]);
const profile = config.profile;
const sessionId = `packed-${profile}-session`;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPrompt = null;

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    await assertCredentialBoundary();
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    });
    continue;
  }
  if (message.method === "session/new") {
    respond(message.id, { sessionId });
    continue;
  }
  if (message.method === "session/resume" || message.method === "session/load") {
    const transcript = transcriptPath();
    const restored = await fs.readFile(transcript, "utf8");
    if (!restored.includes("source")) {
      throw new Error("restored transcript did not contain the source marker");
    }
    await fs.appendFile(transcript, `${JSON.stringify({ marker: "resumed" })}\n`);
    respond(message.id, { sessionId: message.params.sessionId });
    continue;
  }
  if (message.method === "session/prompt") {
    const scenario = scenarioFromPrompt(message.params);
    await assertCredentialBoundary();
    await ensureTranscript(scenario === "resume" ? "resumed-prompt" : "source");
    if (scenario === "cancel") {
      await beginCancellationProbe(message);
      continue;
    }
    await runScenario(scenario);
    sendText(`${scenario}-ok`);
    respond(message.id, { stopReason: "end_turn" });
    continue;
  }
  if (message.method === "session/cancel" && pendingPrompt) {
    respond(pendingPrompt.id, { stopReason: "cancelled" });
    pendingPrompt = null;
  }
}

async function runScenario(scenario) {
  if (scenario === "foreground") {
    const baseline = await fs.readFile(path.join(process.cwd(), "baseline.txt"), "utf8");
    if (baseline !== "baseline\n") throw new Error("Workspace read failed");
    await assertHostReadDenied();
    await tryWrite(path.join(process.cwd(), "read-only-attempt.txt"), "forbidden\n");
    await tryWrite(config.hostWriteCanary, "forbidden\n");
    if (await connectDirect("127.0.0.1", config.loopbackPort, 600)) {
      throw new Error("direct loopback egress unexpectedly succeeded");
    }
    if (await connectDirect("1.1.1.1", 443, 600)) {
      throw new Error("direct public egress unexpectedly succeeded");
    }
    if (await proxyConnect("1.1.1.1", 443, 2_000)) {
      throw new Error("no-fetch proxy unexpectedly allowed an arbitrary public destination");
    }
    if (await proxyConnect("127.0.0.1", config.loopbackPort, 2_000)) {
      throw new Error("proxy unexpectedly allowed a loopback destination");
    }
    return;
  }
  if (scenario === "resume" || scenario === "background") return;
  if (scenario === "write") {
    await assertHostReadDenied();
    await fs.writeFile(path.join(process.cwd(), "write-ok.txt"), "write-ok\n");
    await tryWrite(config.hostWriteCanary, "forbidden\n");
    await fs.writeFile(
      path.join(process.cwd(), ".probe-write.json"),
      `${JSON.stringify({ home: process.env.HOME })}\n`,
    );
    return;
  }
  if (scenario === "isolated") {
    await fs.writeFile(path.join(process.cwd(), "isolated.txt"), "isolated-ok\n");
    return;
  }
  if (scenario === "fetch") {
    if (await connectDirect("1.1.1.1", 443, 600)) {
      throw new Error("direct public egress unexpectedly succeeded with fetch authority");
    }
    if (!(await proxyConnect("1.1.1.1", 443, 12_000))) {
      throw new Error("fetch proxy did not allow the public TCP/443 destination");
    }
    if (await proxyConnect("127.0.0.1", config.loopbackPort, 2_000)) {
      throw new Error("fetch proxy unexpectedly allowed a loopback destination");
    }
    return;
  }
  throw new Error(`unknown package confinement scenario: ${scenario}`);
}

async function beginCancellationProbe(message) {
  const heartbeat = path.join(process.cwd(), ".probe-descendant-heartbeat");
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('fs');const p=process.argv[1];process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(p,'x'),20)",
      heartbeat,
    ],
    { stdio: "ignore" },
  );
  descendant.unref();
  await fs.writeFile(
    path.join(process.cwd(), ".probe-cancel.json"),
    `${JSON.stringify({ heartbeat, home: process.env.HOME })}\n`,
  );
  pendingPrompt = message;
  sendText("cancel-ready");
}

async function assertCredentialBoundary() {
  const configDirectory = profile === "codex"
    ? process.env.CODEX_HOME
    : process.env.CLAUDE_CONFIG_DIR;
  if (!configDirectory) throw new Error("private Profile config directory is missing");
  const credentialName = profile === "codex" ? "auth.json" : ".credentials.json";
  const credential = JSON.parse(await fs.readFile(path.join(configDirectory, credentialName), "utf8"));
  if (credential.probe !== profile) throw new Error("staged credential content is incorrect");
  const decoyName = profile === "codex" ? "config.toml" : "settings.json";
  try {
    await fs.access(path.join(configDirectory, decoyName));
    throw new Error("non-credential Profile config was staged");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (process.env.CONSULT_PACKAGE_SECRET !== undefined) {
    throw new Error("unselected Host environment reached the Profile");
  }
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    if (process.env[name] !== undefined) {
      throw new Error(`credential environment ${name} leaked despite file staging`);
    }
  }
}

async function assertHostReadDenied() {
  try {
    await fs.readFile(config.hostReadCanary);
  } catch {
    return;
  }
  throw new Error("host-only read canary was visible");
}

async function tryWrite(file, content) {
  try {
    await fs.writeFile(file, content);
  } catch {
    // Linux may hide a Host path behind an ephemeral mount while macOS rejects
    // it. The harness asserts the security invariant on the Host filesystem.
  }
}

function transcriptPath() {
  if (profile === "codex") {
    return path.join(
      process.env.CODEX_HOME,
      "sessions",
      "2026",
      "07",
      "10",
      `probe-${sessionId}.jsonl`,
    );
  }
  return path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "probe", `${sessionId}.jsonl`);
}

async function ensureTranscript(marker) {
  const transcript = transcriptPath();
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.appendFile(transcript, `${JSON.stringify({ marker })}\n`);
}

function scenarioFromPrompt(params) {
  const serialized = JSON.stringify(params?.prompt ?? params);
  const match = /scenario ([a-z-]+)/u.exec(serialized);
  if (!match) throw new Error("package confinement scenario is missing from prompt");
  return match[1];
}

function sendText(text) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function connectDirect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (connected) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function proxyConnect(host, port, timeoutMs) {
  const rawProxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!rawProxy) throw new Error("sandbox proxy environment is missing");
  const proxy = new URL(rawProxy);
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = "";
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (allowed) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(allowed);
    };
    socket.once("connect", () => {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      const authorization = Buffer.from(credentials).toString("base64");
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      finish(/^HTTP\/1\.[01] 200 /u.test(response));
    });
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}
