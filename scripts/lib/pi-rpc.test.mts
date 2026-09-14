import { sessionModelIds } from "./session-models.mts";
import { applySessionControls } from "./session-controls.mts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startAgent, newSession, promptTurn, resumeSession, setSessionModel, setSessionConfigOption } from "./acp-client.mts";
import { resolveHostIdentity } from "./host-identity.mts";

const binary = fileURLToPath(new URL("./__fixtures__/fake-pi.mts", import.meta.url));

test("Pi bridge pins tools, preserves JSONL Unicode, waits through retry, controls models, and resumes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-pi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launch = (mode = "read-only") => startAgent({ binary, cwd: root, profileRegistryId: "pi", mode, env: { CONSULT_DATA_DIR: path.join(root, "state") } });
  let id = "";
  const first = await launch();
  try {
    const session = await newSession(first.connection, { cwd: root }); id = session.sessionId;
    assert.ok(sessionModelIds(session).includes("test/other"));
    await applySessionControls(first.connection, { sessionId: id, sessionState: session, model: "test/other", effort: "high", profile: "pi" });
    const events = await collect(promptTurn(first.connection, { sessionId: id, prompt: "review" }));
    const text = events.filter((event) => event.type === "update").map((event: any) => event.update.content?.text ?? "").join("");
    assert.equal(text, "read,grep,find,ls\u2028other:highrecovered");
    assert.equal(events.at(-1)?.type, "stop");
  } finally { await first.dispose(); }
  const second = await launch("write");
  try {
    await resumeSession(second.connection, { cwd: root, sessionId: id });
    const events = await collect(promptTurn(second.connection, { sessionId: id, prompt: "continue" }));
    assert.ok(JSON.stringify(events).includes("read,grep,find,ls,edit,write"));
    await assert.rejects(collect(promptTurn(second.connection, { sessionId: id, prompt: "fail" })), /final failure/);
  } finally { await second.dispose(); }
});

test("Pi cancellation settles and a subsequent turn can run; process death fails the prompt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-pi-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = await startAgent({ binary, cwd: root, profileRegistryId: "pi", env: { CONSULT_DATA_DIR: path.join(root, "state") } });
  try {
    const session = await newSession(agent.connection, { cwd: root });
    const held = agent.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hold" }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await agent.connection.cancel({ sessionId: session.sessionId });
    assert.equal((await held).stopReason, "cancelled");
    await assert.rejects(agent.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "crash" }] }), /Pi exited/);
  } finally { await agent.dispose(); }
});

test("Pi Host detection respects explicit identity and never invents a native Session id", () => {
  assert.deepEqual(resolveHostIdentity({ env: { PI_CODING_AGENT: "true", CODEX_THREAD_ID: "outer" } }), { host: "pi", hostSessionId: "default" });
  assert.deepEqual(resolveHostIdentity({ env: { PI_CODING_AGENT: "true", CONSULT_HOST: "custom", CONSULT_HOST_SESSION_ID: "exact" } }), { host: "custom", hostSessionId: "exact" });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iter) values.push(value);
  return values;
}

test("installed Pi harness executes allowed tools against a local synthetic model", { skip: process.env.CONSULT_TEST_PI !== "1" }, async (t) => {
  const { createServer } = await import("node:http");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-pi-native-"));
  const config = path.join(root, "config"); await fs.mkdir(config);
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const hasTools = input.messages.some((message: any) => message.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!hasTools) {
      chunk({ role: "assistant", tool_calls: [
        { index: 0, id: "read-fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "sample.txt" }) } },
        { index: 1, id: "write-fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "changed.txt", content: "synthetic change" }) } },
      ] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: "verification complete" }); chunk({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(path.join(config, "models.json"), JSON.stringify({ providers: { "consult-test": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "synthetic-placeholder", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } }));
  await fs.writeFile(path.join(root, "sample.txt"), "synthetic content");
  for (const mode of ["read-only", "write"]) {
    const launch = () => startAgent({ binary: "pi", args: ["--provider", "consult-test", "--model", "fixture"], cwd: root, mode, profileRegistryId: "pi", env: { PI_CODING_AGENT_DIR: config, CONSULT_DATA_DIR: path.join(root, "state") } });
    const agent = await launch();
    let sessionId = "";
    try {
      const session = await newSession(agent.connection, { cwd: root });
      sessionId = session.sessionId;
      const events = await collect(promptTurn(agent.connection, { sessionId: session.sessionId, prompt: "Exercise the synthetic tools" }));
      assert.ok(JSON.stringify(events).includes("verification complete"));
      assert.ok(JSON.stringify(events).includes("synthetic content"));
      if (mode === "read-only") await assert.rejects(fs.access(path.join(root, "changed.txt")));
      else assert.equal(await fs.readFile(path.join(root, "changed.txt"), "utf8"), "synthetic change");
    } finally { await agent.dispose(); }
    const resumed = await launch();
    try {
      await resumeSession(resumed.connection, { cwd: root, sessionId });
      const events = await collect(promptTurn(resumed.connection, { sessionId, prompt: "Continue the synthetic task" }));
      assert.ok(JSON.stringify(events).includes("verification complete"));
      const messages = requests.at(-1)!.messages;
      assert.ok(messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("verification complete")));
      assert.ok(messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Exercise the synthetic tools")));
      assert.ok(messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Continue the synthetic task")));
    } finally { await resumed.dispose(); }
  }
});
