import crypto from "node:crypto";

import { getDiff as defaultGetDiff } from "../lib/git.mjs";
import {
  createQueuedJobRecord,
  writeJobRecord as defaultWriteJobRecord,
} from "../lib/job-records.mjs";
import { runPromptTurn } from "../lib/prompt-turn-runner.mjs";
import { createOutput } from "../lib/companion/output.mjs";
import { brokerErrorMessage } from "../lib/prompt-turn-runner.mjs";

export async function runCodexReview({
  profile,
  profileEntry,
  workspaceRoot,
  host,
  hostSessionId,
  baseRef = null,
  kind = "review",
  availableCommandsTimeoutMs: timeoutOverride = null,
  deps = {},
}) {
  const output = createOutput(deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const generateJobId = deps.generateJobId ?? defaultGenerateJobId;
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const getDiff = deps.getDiff ?? defaultGetDiff;
  const slash = `/${kind}`;

  const diff = await getDiff(baseRef ? { baseRef, cwd: workspaceRoot } : { cwd: workspaceRoot });
  const jobId = generateJobId();
  const jobRecord = createQueuedJobRecord({
    jobId,
    kind,
    submittedAt: now(),
    chainId: jobId,
    parentJobId: null,
    delegationDepth: 0,
    mode: "read-only",
    host,
    hostSessionId,
    profile,
    baseRef,
  });
  await writeJobRecord(workspaceRoot, jobId, jobRecord);

  let advertisedCommands = null;
  let advertiseResolve;
  const advertised = new Promise((resolve) => {
    advertiseResolve = resolve;
  });

  try {
    const result = await runPromptTurn({
      workspaceRoot,
      profileEntry,
      jobRecord,
      prompt: `${slash}\n\n${diff}`,
      payloadFields: { baseRef },
      deps,
      output,
      renderUpdate,
      onUpdate(notification) {
        const update = notification.update ?? notification;
        if (update.sessionUpdate === "available_commands_update") {
          advertisedCommands = update.availableCommands ?? [];
          advertiseResolve(advertisedCommands);
        }
      },
      afterAccepted: async () => {
        const commands = await waitForAvailableCommands(
          advertised,
          resolveAvailableCommandsTimeoutMs(deps, timeoutOverride),
        );
        if (!commands.some((command) => command.name === kind || command.name === slash)) {
          output.stderr(
            `codex did not advertise ${slash}; the codex-acp version may not support it\n`,
          );
          return output.result(4);
        }
        return null;
      },
    });
    if (Number.isInteger(result?.exitCode)) {
      return result;
    }
  } catch (error) {
    output.stderr(`${brokerErrorMessage(error)}\n`);
    return output.result(1);
  }
  return output.result(0);
}

function resolveAvailableCommandsTimeoutMs(deps, timeoutOverride) {
  if (timeoutOverride !== null) {
    return timeoutOverride;
  }
  if (deps.availableCommandsTimeoutMs !== undefined) {
    return deps.availableCommandsTimeoutMs;
  }
  return Number(process.env.CONSULT_AVAILABLE_COMMANDS_TIMEOUT_MS ?? 2000);
}

function waitForAvailableCommands(advertised, timeoutMs) {
  let timeout;
  return Promise.race([
    advertised,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve([]), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function renderUpdate(notification) {
  const update = notification.update ?? notification;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  if (update.sessionUpdate === "tool_call") {
    return `[tool_call ${update.toolCall?.name ?? update.name ?? "unknown"}]\n`;
  }
  return "";
}

function defaultGenerateJobId() {
  return `job-${crypto.randomBytes(9).toString("base64url").slice(0, 12)}`;
}
