import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream, type Agent, type SessionUpdate, type SessionConfigOption, type ContentBlock } from "@agentclientprotocol/sdk";
import { dataDir } from "./lib/broker-endpoint.mts";
import { boundedJsonlStream } from "./lib/jsonl-framing.mts";
import { versionAtLeast } from "./lib/profile-launch-policy.mts";
import { PiRpc, type PiEvent } from "./lib/pi-rpc.mts";

const [binary, mode, encodedArgs] = process.argv.slice(2);
const extraArgs: string[] = JSON.parse(encodedArgs ?? "[]");
// Profile args may select a provider/model, never change tool or startup policy.
for (let i = 0; i < extraArgs.length; i += 2) {
  if (!["--provider", "--model", "--thinking"].includes(extraArgs[i]) || !extraArgs[i + 1] || extraArgs[i + 1].startsWith("-")) {
    throw new RequestError(-32000, "Pi Profile args support only --provider, --model, and --thinking pairs");
  }
}
if (!binary || !["read-only", "write"].includes(mode)) throw new RequestError(-32000, "invalid internal Pi launch");
let rpc: PiRpc | undefined;
let sessionId = "";
let notifications: Promise<void> = Promise.resolve();
let turn: { resolve: (value: { stopReason: "end_turn" | "cancelled" | "max_tokens" }) => void; reject: (error: Error) => void; cancelled: boolean; error?: string; stopReason?: string } | undefined;
let configOptions: SessionConfigOption[] = [];
let models: Array<{ provider: string; id: string; name?: string }> = [];

const connection = new AgentSideConnection((): Agent => ({
  async initialize() {
    const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    const version = stdout.trim();
    if (!versionAtLeast(version, "0.84.4")) throw new RequestError(-32000, "Consult requires Pi 0.84.4+ (agent_settled and tool allowlists)");
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "consult-pi", version }, agentCapabilities: { sessionCapabilities: { resume: {} } } };
  },
  async authenticate() { throw new RequestError(-32000, "Configure provider authentication in pi, then retry Consult"); },
  async newSession(params) {
    if (rpc) throw new RequestError(-32000, "one Pi Session per Consult transport");
    sessionId = crypto.randomUUID();
    return { sessionId, ...await open(params.cwd, sessionId, params.mcpServers, false) };
  },
  async resumeSession(params) {
    if (rpc) throw new RequestError(-32000, "one Pi Session per Consult transport");
    if (!/^[0-9a-f-]{36}$/u.test(params.sessionId)) throw new RequestError(-32000, "invalid Pi Session id");
    sessionId = params.sessionId;
    return await open(params.cwd, sessionId, params.mcpServers, true);
  },
  async unstable_setSessionModel(params) {
    checkSession(params.sessionId);
    const separator = params.modelId.indexOf("/");
    if (separator < 1) throw new RequestError(-32000, "Pi model id must be provider/model");
    await rpc!.request("set_model", { provider: params.modelId.slice(0, separator), modelId: params.modelId.slice(separator + 1) });
    await controls();
    return {};
  },
  async setSessionConfigOption(params) {
    checkSession(params.sessionId);
    if (typeof params.value !== "string") throw new RequestError(-32000, "invalid Pi config value");
    const option = configOptions.find((option) => option.id === params.configId);
    if (!option || option.type !== "select" || !option.options.some((item) => "value" in item && item.value === params.value)) throw new RequestError(-32000, "unsupported Pi thinking level");
    if (params.configId === "model") {
      const model = models.find((model) => `${model.provider}/${model.id}` === params.value)!;
      await rpc!.request("set_model", { provider: model.provider, modelId: model.id });
    } else if (params.configId === "thinking") await rpc!.request("set_thinking_level", { level: params.value });
    else throw new RequestError(-32000, "unknown Pi config option");
    return { configOptions: await controls() };
  },
  async prompt(params) {
    checkSession(params.sessionId);
    if (turn) throw new RequestError(-32000, "Pi prompt already active");
    if (params.prompt.some((block: ContentBlock) => block.type !== "text")) throw new RequestError(-32000, "Pi bridge currently accepts text prompts only");
    // Prefix blocks so a cold task cannot invoke Pi's slash/bang commands.
    const message = "Consult delegated task:\n\n" + params.prompt.map((block: ContentBlock) => block.type === "text" ? block.text : "").join("\n\n");
    const completion = new Promise<{ stopReason: "end_turn" | "cancelled" | "max_tokens" }>((resolve, reject) => { turn = { resolve, reject, cancelled: false }; });
    const active = turn;
    try {
      const [, result] = await Promise.all([rpc!.request("prompt", { message }), completion]);
      return result;
    } catch (error) {
      if (turn === active) turn = undefined;
      rpc!.close();
      throw new RequestError(-32000, error instanceof Error ? error.message : String(error));
    }
  },
  async cancel(params) {
    checkSession(params.sessionId);
    if (!turn) return;
    turn.cancelled = true;
    await rpc!.request("clear_queue");
    await rpc!.request("abort");
  },
}), ndJsonStream(Writable.toWeb(process.stdout), (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>).pipeThrough(boundedJsonlStream())));

async function open(cwd: string, id: string, mcpServers: unknown[], resume: boolean) {
  if (rpc) throw new RequestError(-32000, "one Pi Session per Consult transport");
  if (mcpServers.length) throw new RequestError(-32000, "Pi bridge does not forward MCP servers");
  const realCwd = await fs.realpath(cwd);
  if (realCwd !== await fs.realpath(process.cwd())) throw new RequestError(-32000, "Pi Session cwd differs from its Execution Workspace");
  const root = path.join(dataDir(), "pi-sessions", crypto.createHash("sha256").update(realCwd).digest("hex"));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(root, `${id}.jsonl`);
  if (resume && !(await fs.stat(sessionFile)).isFile()) throw new RequestError(-32000, "Pi Session file missing");
  rpc = new PiRpc(binary, ["--mode", "rpc", "--session", sessionFile, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--tools", mode === "write" ? "read,grep,find,ls,edit,write" : "read,grep,find,ls", ...extraArgs], realCwd);
  rpc.onFailure = (error) => { turn?.reject(error); turn = undefined; };
  rpc.onEvent = observe;
  await rpc.request("get_state");
  models = (await rpc.request("get_available_models"))?.models ?? [];
  return { configOptions: await controls() };
}

async function controls(): Promise<SessionConfigOption[]> {
  const levels = await rpc!.request("get_available_thinking_levels");
  const state = await rpc!.request("get_state");
  configOptions = [
    ...(models.length ? [{ id: "model", name: "Model", category: "model" as const, type: "select" as const, currentValue: state.model ? `${state.model.provider}/${state.model.id}` : "", options: models.map((model) => ({ value: `${model.provider}/${model.id}`, name: model.name ?? model.id })) }] : []),
    { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: state.thinkingLevel ?? "off", options: (levels?.levels ?? ["off"]).map((level: string) => ({ value: level, name: level })) }];
  return configOptions;
}

function checkSession(id: string) {
  if (!rpc || id !== sessionId) throw RequestError.invalidParams({ sessionId: id });
}

function notify(update: SessionUpdate) {
  notifications = notifications.then(() => connection.sessionUpdate({ sessionId, update }));
  notifications.catch((error) => rpc?.fail(error));
}

function observe(event: PiEvent) {
  if (!turn) return;
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent;
    if (delta?.type === "text_delta") notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } });
    if (delta?.type === "thinking_delta") notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } });
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    turn.error = event.message.stopReason === "error" ? event.message.errorMessage ?? "Pi model request failed" : undefined;
    turn.stopReason = event.message.stopReason;
  }
  if (event.type === "auto_retry_end" && event.success === false) turn.error = event.finalError ?? "Pi exhausted its retry budget";
  if (event.type === "compaction_end" && !event.result && !event.aborted) turn.error = event.errorMessage ?? "Pi compaction failed";
  if (event.type === "tool_execution_start") notify({ sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.toolName, kind: ["write", "edit"].includes(event.toolName) ? "edit" : ["grep", "find", "ls"].includes(event.toolName) ? "search" : "read", status: "in_progress", rawInput: event.args });
  if (event.type === "tool_execution_end") notify({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: event.isError ? "failed" : "completed", rawOutput: event.result });
  if (event.type === "agent_settled") {
    const settled = turn;
    turn = undefined;
    notifications.then(() => {
      if (settled.cancelled || settled.stopReason === "aborted") settled.resolve({ stopReason: "cancelled" });
      else if (settled.error) settled.reject(new Error(settled.error));
      else if (!settled.stopReason) settled.reject(new Error("Pi settled without a final assistant message"));
      else settled.resolve({ stopReason: settled.stopReason === "length" ? "max_tokens" : "end_turn" });
    }, settled.reject);
  }
  return notifications;
}

process.stdin.on("end", () => rpc?.close());
