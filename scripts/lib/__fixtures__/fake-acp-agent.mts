import fs from "node:fs";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

interface FakeAgentMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  // Raw JSON-RPC params from the harness under test; shapes vary per method.
  params?: any;
  result?: unknown;
  error?: unknown;
}

interface AgentCapabilities {
  loadSession: boolean;
  sessionCapabilities: Record<string, unknown>;
}

interface SessionConfigOption {
  type: string;
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: { name: string; value: string }[];
}

interface SessionControls {
  models?: {
    availableModels: { modelId: string; name: string }[];
    currentModelId: string;
  };
  configOptions?: SessionConfigOption[];
}

const mode = process.argv[2] ?? "happy";
const scenario = process.argv[3] ?? "default";
const promptLogPath = process.env.CONSULT_FAKE_AGENT_PROMPT_LOG;
const cancelLogPath = process.env.CONSULT_FAKE_AGENT_CANCEL_LOG;
const clientLogPath = process.env.CONSULT_FAKE_AGENT_CLIENT_LOG;
const methodLogPath = process.env.CONSULT_FAKE_AGENT_METHOD_LOG;
const envLogPath = process.env.CONSULT_FAKE_AGENT_ENV_LOG;
const targetPath = process.env.CONSULT_FAKE_AGENT_TARGET_PATH;
const AUTO_APPROVED_EDIT_SCENARIOS = new Set([
  "prompt-auto-approved-edit",
  "prompt-auto-approved-edit-outside-workspace",
]);
const CLAUDE_STYLE_EDIT_SCENARIOS = new Set([
  "prompt-claude-style-edit-outside",
  "prompt-claude-style-edit-inside",
]);
let promptCount = 0;
let cancellablePrompt: FakeAgentMessage | null = null;
let nextClientRequestId = 1;
const pendingClientRequests = new Map<
  number | string | undefined,
  (message: FakeAgentMessage) => void
>();

if (envLogPath) {
  fs.appendFileSync(
    envLogPath,
    `${JSON.stringify({
      CONSULT_PARENT_JOB: process.env.CONSULT_PARENT_JOB ?? null,
      CONSULT_WORKSPACE: process.env.CONSULT_WORKSPACE ?? null,
    })}\n`,
  );
}

if (mode === "exit") {
  fs.writeSync(2, "boom\n");
  process.exit(1);
}

if (mode === "hang") {
  setTimeout(() => process.exit(0), 1000);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (mode === "sessions" || mode === "stubborn") {
  if (mode === "stubborn") {
    process.on("SIGTERM", () => {});
  }
  const buffer = Buffer.alloc(4096);
  let input = "";

  while (true) {
    const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      if (mode === "stubborn") {
        sleep(25);
        continue;
      }
      process.exit(0);
    }

    input += buffer.toString("utf8", 0, bytesRead);
    let newlineIndex: number;
    while ((newlineIndex = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newlineIndex);
      input = input.slice(newlineIndex + 1);
      if (line.trim()) {
        handleMessage(JSON.parse(line));
      }
    }
  }
}

await new Promise((resolve) => setTimeout(resolve, 25));

fs.writeSync(
  1,
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: capabilitiesForScenario(scenario),
    },
  })}\n`,
);

fs.readFileSync(0);

function handleMessage(message: FakeAgentMessage): void {
  if (pendingClientRequests.has(message.id)) {
    const resolve = pendingClientRequests.get(message.id)!;
    pendingClientRequests.delete(message.id);
    resolve(message);
    return;
  }

  logAgentMethod(message);

  if (message.method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: capabilitiesForScenario(scenario),
      },
    });
    return;
  }

  if (message.method === "session/new") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "sess-1",
        ...sessionControlsForScenario(scenario),
      },
    });
    return;
  }

  if (message.method === "session/resume" || message.method === "session/load") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: message.params.sessionId,
        ...sessionControlsForScenario(scenario),
      },
    });
    return;
  }

  if (message.method === "session/set_model") {
    if (!sessionControlsForScenario(scenario).models) {
      writeError(message.id, -32601, "method not found: session/set_model");
      return;
    }
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    return;
  }

  if (message.method === "session/set_config_option") {
    const controls = sessionControlsForScenario(scenario);
    if (!controls.configOptions) {
      writeError(message.id, -32601, "method not found: session/set_config_option");
      return;
    }
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        configOptions: controls.configOptions,
      },
    });
    return;
  }

  if (message.method === "session/prompt") {
    promptCount += 1;
    if (promptLogPath) {
      fs.appendFileSync(promptLogPath, `${JSON.stringify(message.params)}\n`);
    }
    if (scenario === "prompt-cancel-ack") {
      if (promptCount > 1) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
        return;
      }
      writeUpdate(message.params.sessionId, "slow");
      cancellablePrompt = message;
      return;
    }
    if (scenario === "prompt-first-resolve-second-cancel-ack") {
      if (promptCount === 1) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
        return;
      }
      writeUpdate(message.params.sessionId, "slow");
      cancellablePrompt = message;
      return;
    }
    if (scenario === "prompt-cancel-no-ack") {
      writeUpdate(message.params.sessionId, "slow");
      cancellablePrompt = message;
      return;
    }
    const manyUpdatesMatch = /^prompt-many-updates-(\d+)$/.exec(scenario);
    if (manyUpdatesMatch) {
      for (let index = 0; index < Number(manyUpdatesMatch[1]); index += 1) {
        writeUpdate(message.params.sessionId, `update-${index}`);
      }
    }
    if (scenario === "prompt-updates") {
      writeUpdate(message.params.sessionId, "first");
      writeUpdate(message.params.sessionId, "second");
    }
    if (scenario === "prompt-reattach") {
      writeUpdate(message.params.sessionId, `buffered-${promptCount}`);
      sleep(50);
      writeUpdate(message.params.sessionId, `live-${promptCount}`);
      sleep(50);
    }
    if (scenario === "prompt-reattach-busy") {
      writeUpdate(message.params.sessionId, `buffered-${promptCount}`);
      sleep(150);
      writeUpdate(message.params.sessionId, `live-${promptCount}`);
      sleep(150);
    }
    if (scenario === "prompt-pre-resolve-update") {
      writeUpdate(message.params.sessionId, "before-response");
    }
    if (scenario === "prompt-permission-edit") {
      callClient("session/request_permission", {
        sessionId: message.params.sessionId,
        options: permissionOptions(),
        toolCall: {
          toolCallId: "call-1",
          kind: "edit",
          rawInput: { path: targetPath ?? "inside.txt" },
        },
      }, (response) => {
        logClientObservation("session/request_permission", response);
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
      });
      return;
    }
    if (scenario === "prompt-fs-read") {
      callClient("fs/read_text_file", {
        sessionId: message.params.sessionId,
        path: targetPath,
      }, (response) => {
        logClientObservation("fs/read_text_file", response);
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
      });
      return;
    }
    if (scenario === "prompt-fs-write") {
      callClient("fs/write_text_file", {
        sessionId: message.params.sessionId,
        path: targetPath,
        content: "changed by fake agent\n",
      }, (response) => {
        logClientObservation("fs/write_text_file", response);
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
      });
      return;
    }
    if (AUTO_APPROVED_EDIT_SCENARIOS.has(scenario) || CLAUDE_STYLE_EDIT_SCENARIOS.has(scenario)) {
      if (promptCount > 1) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            stopReason: "end_turn",
          },
        });
        return;
      }
      const editPath =
        scenario === "prompt-auto-approved-edit-outside-workspace"
          ? targetPath ?? "/etc/hostname"
          : scenario === "prompt-claude-style-edit-outside"
            ? targetPath ?? "/tmp/outside.txt"
          : targetPath ?? "inside.txt";
      if (CLAUDE_STYLE_EDIT_SCENARIOS.has(scenario)) {
        writeClaudeStyleEdit(message.params.sessionId, editPath);
      } else {
        writeAutoApprovedEdit(message.params.sessionId, editPath);
      }
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
        },
      });
      return;
    }
    if (scenario === "prompt-fanout") {
      writeUpdate(message.params.sessionId, "fanout");
    }
    if (scenario === "prompt-slow") {
      writeUpdate(message.params.sessionId, "slow");
      sleep(200);
    }
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        stopReason: "end_turn",
      },
    });
    if (scenario === "prompt-delayed-post-resolve-update") {
      sleep(25);
      writeUpdate(message.params.sessionId, "delayed-response");
    }
    if (scenario === "prompt-post-resolve-update") {
      writeUpdate(message.params.sessionId, "after-response");
    }
    return;
  }

  if (message.method === "session/cancel") {
    if (cancelLogPath) {
      fs.appendFileSync(cancelLogPath, `${JSON.stringify(message.params)}\n`);
    }
    if (
      (scenario === "prompt-cancel-ack" ||
        scenario === "prompt-first-resolve-second-cancel-ack" ||
        AUTO_APPROVED_EDIT_SCENARIOS.has(scenario) ||
        CLAUDE_STYLE_EDIT_SCENARIOS.has(scenario)) &&
      cancellablePrompt
    ) {
      writeMessage({
        jsonrpc: "2.0",
        id: cancellablePrompt.id,
        result: {
          stopReason: "cancelled",
        },
      });
      cancellablePrompt = null;
    }
  }
}

function capabilitiesForScenario(currentScenario: string): AgentCapabilities {
  if (currentScenario === "capabilities-no-resume") {
    return {
      loadSession: false,
      sessionCapabilities: {},
    };
  }
  if (currentScenario === "capabilities-load-only") {
    return {
      loadSession: true,
      sessionCapabilities: {},
    };
  }
  return {
    loadSession: true,
    sessionCapabilities: {
      resume: {},
    },
  };
}

function sessionControlsForScenario(currentScenario: string): SessionControls {
  if (currentScenario !== "controls" && currentScenario !== "controls-config-model") {
    return {};
  }
  return {
    ...(currentScenario === "controls"
      ? {
          models: {
            availableModels: [
              { modelId: "default-model", name: "Default Model" },
              { modelId: "gpt-test", name: "GPT Test" },
            ],
            currentModelId: "default-model",
          },
        }
      : {}),
    configOptions: [
      ...(currentScenario === "controls-config-model"
        ? [
            {
              type: "select",
              id: "model-option",
              name: "Model",
              category: "model",
              currentValue: "default-model",
              options: [
                { name: "Default Model", value: "default-model" },
                { name: "GPT Test", value: "gpt-test" },
              ],
            },
          ]
        : []),
      {
        type: "select",
        id: "thought-level",
        name: "Thought Level",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
        ],
      },
    ],
  };
}

function writeMessage(message: unknown): void {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function writeError(id: number | string | undefined, code: number, message: string): void {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function logAgentMethod(message: FakeAgentMessage): void {
  if (methodLogPath && message.method) {
    fs.appendFileSync(
      methodLogPath,
      `${JSON.stringify({ method: message.method, params: message.params })}\n`,
    );
  }
}

function writeUpdate(sessionId: string, text: string): void {
  writeMessage({
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

function writeAutoApprovedEdit(sessionId: string, editPath: string): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-auto-edit",
        title: "Edit inside.txt",
        kind: "edit",
        rawInput: {
          path: editPath,
          auto_approved: true,
        },
      },
    },
  });
}

function writeClaudeStyleEdit(sessionId: string, editPath: string): void {
  writeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-claude-edit",
        title: "Edit file",
        kind: "edit",
        locations: [{ path: editPath }],
        rawInput: {
          file_path: editPath,
        },
      },
    },
  });
}

function callClient(
  method: string,
  params: Record<string, unknown>,
  onResponse: (message: FakeAgentMessage) => void,
): void {
  const id = `client-${nextClientRequestId++}`;
  pendingClientRequests.set(id, onResponse);
  writeMessage({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
}

function permissionOptions(): { kind: string; name: string; optionId: string }[] {
  return [
    {
      kind: "allow_once",
      name: "Allow",
      optionId: "allow",
    },
    {
      kind: "reject_once",
      name: "Deny",
      optionId: "reject",
    },
  ];
}

function logClientObservation(method: string, message: unknown): void {
  if (clientLogPath) {
    fs.appendFileSync(clientLogPath, `${JSON.stringify({ method, message })}\n`);
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
