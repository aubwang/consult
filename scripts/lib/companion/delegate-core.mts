import { ensureInlineSession } from "../inline-turn-runner.mts";
import {
  failJobRecord,
  JOB_STATUS,
  jobLogPath,
  statusFromStopReason,
  writeJobRecord as defaultWriteJobRecord,
} from "../job-records.mts";
import { jobResultEnvelope } from "../job-result-contract.mts";
import {
  cleanupIsolatedWorkspace as defaultCleanupIsolatedWorkspace,
  finalizeIsolatedWorkspace as defaultFinalizeIsolatedWorkspace,
} from "../isolated-workspace.mts";
import type {
  FinalizedIsolatedWorkspace,
  PreparedIsolatedWorkspace,
} from "../isolated-workspace.mts";
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
  finalizeIsolatedWorkspace?: (
    prepared: PreparedIsolatedWorkspace,
  ) => Promise<FinalizedIsolatedWorkspace>;
  cleanupIsolatedWorkspace?: (prepared: PreparedIsolatedWorkspace) => Promise<unknown>;
}

export interface RunDelegateOnceOptions {
  workspaceRoot: string;
  executionRoot?: string;
  profileEntry: Partial<ProfileRecord>;
  jobRecord: JobRecord;
  kind?: string;
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
  allowExecute?: boolean;
  isolatedWorkspace?: PreparedIsolatedWorkspace;
}

export async function runDelegateOnce({
  workspaceRoot,
  executionRoot,
  profileEntry,
  jobRecord,
  kind = "delegate",
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
  isolatedWorkspace,
}: RunDelegateOnceOptions): Promise<NullOutputResult> {
  // Foreground delegates run the ACP agent in-process (ADR-0021); background
  // jobs keep the Broker daemon. An injected ensureBrokerSession still wins so
  // tests and callers can substitute their own session transport.
  const effectiveDeps = inline
    ? { ...deps, ensureBrokerSession: deps.ensureBrokerSession ?? ensureInlineSession }
    : deps;
  let result;
  try {
    result = await runPromptTurn({
      workspaceRoot,
      executionRoot,
      profileEntry,
      jobRecord,
      prompt,
      payloadFields: {
        kind,
        resume: resumeSessionId,
        model,
        effort,
      },
      deps: effectiveDeps,
      output,
      renderUpdate: json
        ? () => ""
        : (renderSessionUpdate as (notification: unknown) => string),
      markFailedOnBrokerError,
    });
  } catch (error) {
    if (isolatedWorkspace) {
      await settleIsolatedWorkspace({
        workspaceRoot,
        jobRecord,
        prepared: isolatedWorkspace,
        deps,
        output,
      });
    }
    throw error;
  }
  const isolationError = isolatedWorkspace
    ? await settleIsolatedWorkspace({
        workspaceRoot,
        jobRecord,
        prepared: isolatedWorkspace,
        deps,
        output,
      })
    : null;
  if (isolationError) {
    return output.result(6);
  }
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
        `${JSON.stringify(
          jobResultEnvelope(jobRecord, {
            logPath: jobLogPath(workspaceRoot, jobRecord.jobId as string),
          }),
        )}\n`,
      );
    } else {
      output.stdout(
        `${summaryPrefix}consult ${kind} ${jobRecord.jobId} ${statusFromStopReason(
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

async function settleIsolatedWorkspace({
  workspaceRoot,
  jobRecord,
  prepared,
  deps,
  output,
}: {
  workspaceRoot: string;
  jobRecord: JobRecord;
  prepared: PreparedIsolatedWorkspace;
  deps: RunDelegateOnceDeps;
  output: NullOutput;
}): Promise<Error | null> {
  const finalize = deps.finalizeIsolatedWorkspace ?? defaultFinalizeIsolatedWorkspace;
  const cleanup = deps.cleanupIsolatedWorkspace ?? defaultCleanupIsolatedWorkspace;
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const errors: Error[] = [];
  try {
    const artifacts = await finalize(prepared);
    Object.assign(jobRecord, {
      touchedFiles: artifacts.touchedFiles,
      patchPath: artifacts.patchPath,
      patchBytes: artifacts.patchBytes,
      touchedFilesPath: artifacts.touchedFilesPath,
      cleanupMetadataPath: artifacts.cleanupMetadataPath,
    });
  } catch (error) {
    errors.push(error as Error);
  }
  try {
    await cleanup(prepared);
  } catch (error) {
    errors.push(error as Error);
  }

  if (errors.length > 0) {
    const message = `isolated workspace finalization failed: ${errors
      .map((error) => error.message)
      .join("; ")}`;
    failJobRecord(jobRecord, {
      now: deps.now,
      errorMessage: message,
      finalText: jobRecord.finalText,
      sessionId: jobRecord.sessionId,
    });
    output.stderr(`${message}\n`);
  }
  await writeJobRecord(workspaceRoot, jobRecord.jobId as string, jobRecord);
  return errors[0] ?? null;
}
