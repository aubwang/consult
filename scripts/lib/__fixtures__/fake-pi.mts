#!/usr/bin/env node
import fs from "node:fs";
import { readJsonlMessages } from "../jsonl-framing.mts";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.84.4"); process.exit(0); }
if (!args.includes("--no-extensions") || !args.includes("--no-skills") || !args.includes("--no-prompt-templates")) process.exit(5);
const tools = args[args.indexOf("--tools") + 1];
const sessionFile = args[args.indexOf("--session") + 1];
let buffer: Buffer = Buffer.alloc(0);
let model = { provider: "test", id: "test-model", name: "Test model" };
let thinkingLevel = "off";
let active = false;
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
const text = (text: string) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
const settled = () => { active = false; emit({ type: "agent_settled" }); };
process.stdin.on("data", (chunk: Buffer) => {
  const frame = readJsonlMessages(buffer, chunk); buffer = frame.buffer;
  for (const line of frame.lines) {
    const request = JSON.parse(line);
    let data: unknown;
    switch (request.type) {
      case "get_state": data = { model, thinkingLevel, sessionFile }; break;
      case "get_available_models": data = { models: [model, { provider: "test", id: "other" }] }; break;
      case "get_available_thinking_levels": data = { levels: model.id === "other" ? ["off", "high"] : ["off"] }; break;
      case "set_thinking_level": thinkingLevel = request.level; break;
      case "set_model": model = { provider: request.provider, id: request.modelId, name: "Other" }; break;
      case "prompt": {
        active = true;
        fs.appendFileSync(sessionFile, request.message + "\n");
        emit({ type: "response", id: request.id, command: request.type, success: true });
        if (request.message.includes("hold")) continue;
        if (request.message.includes("crash")) process.exit(7);
        text(tools + "\u2028" + model.id + ":" + thinkingLevel);
        emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "transient" } });
        emit({ type: "agent_end", willRetry: true });
        setTimeout(() => {
          if (!active) return;
          text("recovered");
          emit({ type: "message_end", message: { role: "assistant", stopReason: request.message.includes("fail") ? "error" : "stop", errorMessage: "final failure" } });
          settled();
        }, 150);
        continue;
      }
      case "abort": if (active) settled(); break;
    }
    emit({ type: "response", id: request.id, command: request.type, success: true, data });
  }
});
