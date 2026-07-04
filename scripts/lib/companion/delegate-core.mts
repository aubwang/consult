import { ensureInlineSession } from "../inline-turn-runner.mts";
import { JOB_STATUS, jobLogPath, statusFromStopReason } from "../job-records.mts";
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
  inline?: boolean;
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
  inline = false,
}: RunDelegateOnceOptions): Promise<NullOutputResult> {
  // Foreground delegates run the ACP agent in-process (ADR-0021); background
  // jobs keep the Broker daemon. An injected ensureBrokerSession still wins so
  // tests and callers can substitute their own session transport.
  const effectiveDeps = inline
    ? { ...deps, ensureBrokerSession: deps.ensureBrokerSession ?? ensureInlineSession }
    : deps;
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
    deps: effectiveDeps,
    output,
    renderUpdate: renderSessionUpdate as (notification: unknown) => string,
    markFailedOnBrokerError,
  });
  if (Number.isInteger((result as NullOutputResult)?.exitCode)) {
    return result as NullOutputResult;
  }
  const { finalNotification, finalText } = result as {
    finalNotification: { stopReason: string; sessionId: string };
    finalText: string;
  };
  if (renderSummary) {
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
  // Exit code contract: a turn that finalized as failed exits 6 so callers
  // checking exit codes do not mistake a failed delegation for success.
  return output.result(
    statusFromStopReason(finalNotification.stopReason) === JOB_STATUS.FAILED ? 6 : 0,
  );
}
