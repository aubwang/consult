import path from "node:path";

import { logsDir } from "../broker-endpoint.mjs";
import { statusFromStopReason } from "../job-records.mjs";
import {
  brokerErrorMessage,
  exitCodeForBrokerError,
  runPromptTurn,
} from "../prompt-turn-runner.mjs";

export { statusFromStopReason } from "../job-records.mjs";
export { brokerErrorMessage, exitCodeForBrokerError } from "../prompt-turn-runner.mjs";

export async function runDelegateOnce({
  workspaceRoot,
  profileEntry,
  jobRecord,
  prompt,
  model,
  effort,
  resumeSessionId = null,
  deps = {},
  output = createNullOutput(),
  json = false,
  renderSummary = true,
  markFailedOnBrokerError = false,
}) {
  const result = await runPromptTurn({
    workspaceRoot,
    profileEntry,
    jobRecord,
    prompt,
    payloadFields: {
      kind: "delegate",
      resume: resumeSessionId,
      model,
      effort,
    },
    deps,
    output,
    renderUpdate,
    markFailedOnBrokerError,
  });
  if (Number.isInteger(result?.exitCode)) {
    return result;
  }
  if (renderSummary) {
    const { finalNotification, finalText } = result;
    const summaryPrefix = finalText.length > 0 && !finalText.endsWith("\n") ? "\n" : "";
    if (json) {
      output.stdout(
        `${summaryPrefix}${JSON.stringify({
          status: statusFromStopReason(finalNotification.stopReason),
          jobId: jobRecord.jobId,
          sessionId: finalNotification.sessionId,
          stopReason: finalNotification.stopReason,
          finalTextLength: finalText.length,
          logPath: path.join(logsDir(workspaceRoot), `${jobRecord.jobId}.log`),
        })}\n`,
      );
    } else {
      output.stdout(
        `${summaryPrefix}consult delegate ${jobRecord.jobId} ${statusFromStopReason(
          finalNotification.stopReason,
        )}\n`,
      );
    }
  }
  return output.result(0);
}

export function renderUpdate(notification) {
  const update = notification.update ?? notification;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  if (update.sessionUpdate === "tool_call") {
    if (update.kind != null || update.title != null) {
      return `[tool_call ${update.kind ?? ""}${update.kind && update.title ? ": " : ""}${
        update.title ?? ""
      }]\n`;
    }
    return `[tool_call ${update.toolCall?.name ?? update.name ?? "unknown"}]\n`;
  }
  if (update.sessionUpdate === "tool_call_update") {
    // These are status-change events for ongoing tool calls, not actionable display info.
    return "";
  }
  return "";
}

function createNullOutput() {
  return {
    stdout() {},
    stderr() {},
    result(exitCode) {
      return { exitCode, stdout: "", stderr: "" };
    },
  };
}
