import { jobLogPath, statusFromStopReason } from "../job-records.mts";
import { createNullOutput } from "../null-output.mts";
import type { NullOutput, NullOutputResult } from "../null-output.mts";
import type { JobRecord } from "../job-records.mts";
import type { ProfileRecord } from "../profiles.mts";
import {
  brokerErrorMessage,
  exitCodeForBrokerError,
  runPromptTurn,
} from "../prompt-turn-runner.mts";
import type {
  EnsureBrokerSessionInput,
  EnsureBrokerSessionResult,
} from "../prompt-turn-runner.mts";
import { renderSessionUpdate } from "../session-update-renderer.mts";

export { statusFromStopReason } from "../job-records.mts";
export { brokerErrorMessage, exitCodeForBrokerError } from "../prompt-turn-runner.mts";
export { renderSessionUpdate as renderUpdate } from "../session-update-renderer.mts";

export interface RunDelegateOnceDeps {
  ensureBrokerSession?: (
    input: EnsureBrokerSessionInput,
  ) => Promise<EnsureBrokerSessionResult>;
  appendLogLine?: (
    workspaceRoot: string,
    jobId: string,
    notification: unknown,
  ) => Promise<void>;
  writeJobRecord?: (workspaceRoot: string, jobId: string, record: JobRecord) => Promise<void>;
  now?: () => string;
  maxFinalTextChars?: number;
}

export interface RunDelegateOnceOptions {
  workspaceRoot: string;
  profileEntry: Partial<ProfileRecord>;
  jobRecord: JobRecord;
  prompt?: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string | null;
  deps?: RunDelegateOnceDeps;
  output?: NullOutput;
  json?: boolean;
  renderSummary?: boolean;
  markFailedOnBrokerError?: boolean;
}

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
}: RunDelegateOnceOptions): Promise<NullOutputResult> {
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
    renderUpdate: renderSessionUpdate as (notification: unknown) => string,
    markFailedOnBrokerError,
  });
  if (Number.isInteger((result as NullOutputResult)?.exitCode)) {
    return result as NullOutputResult;
  }
  if (renderSummary) {
    const { finalNotification, finalText } = result as {
      finalNotification: { stopReason: string; sessionId: string };
      finalText: string;
    };
    const summaryPrefix = finalText.length > 0 && !finalText.endsWith("\n") ? "\n" : "";
    if (json) {
      output.stdout(
        `${summaryPrefix}${JSON.stringify({
          status: statusFromStopReason(finalNotification.stopReason),
          jobId: jobRecord.jobId,
          sessionId: finalNotification.sessionId,
          stopReason: finalNotification.stopReason,
          finalTextLength: finalText.length,
          logPath: jobLogPath(workspaceRoot, jobRecord.jobId as string),
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
