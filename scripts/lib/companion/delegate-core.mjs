import { jobLogPath, statusFromStopReason } from "../job-records.mjs";
import { createNullOutput } from "../null-output.mjs";
import {
  brokerErrorMessage,
  exitCodeForBrokerError,
  runPromptTurn,
} from "../prompt-turn-runner.mjs";
import { renderSessionUpdate } from "../session-update-renderer.mjs";

export { statusFromStopReason } from "../job-records.mjs";
export { brokerErrorMessage, exitCodeForBrokerError } from "../prompt-turn-runner.mjs";
export { renderSessionUpdate as renderUpdate } from "../session-update-renderer.mjs";

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
    renderUpdate: renderSessionUpdate,
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
          logPath: jobLogPath(workspaceRoot, jobRecord.jobId),
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
