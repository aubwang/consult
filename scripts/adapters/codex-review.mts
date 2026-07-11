import {
  appendPinnedDiff,
  getDiff as defaultGetDiff,
  pinnedDiffErrorMessage,
} from "../lib/git.mts";
import type { GetDiffOptions } from "../lib/git.mts";
import {
  createQueuedJobRecord,
  jobLogPath,
  statusFromStopReason,
  writeJobRecord as defaultWriteJobRecord,
} from "../lib/job-records.mts";
import { jobResultEnvelope } from "../lib/job-result-contract.mts";
import { defaultGenerateJobId } from "../lib/job-ids.mts";
import { runPromptTurn, brokerErrorMessage } from "../lib/prompt-turn-runner.mts";
import type { PromptTurnDeps } from "../lib/prompt-turn-runner.mts";
import { createOutput } from "../lib/companion/output.mts";
import type { OutputDeps } from "../lib/companion/output.mts";
import { renderSessionUpdate } from "../lib/session-update-renderer.mts";
import type { NullOutputResult } from "../lib/null-output.mts";
import { DEFAULT_JOB_AUTHORITY } from "../lib/job-authority.mts";
import type { JobAuthority } from "../lib/job-authority.mts";

export interface CodexReviewDeps extends PromptTurnDeps, OutputDeps {
  getDiff?: (opts: GetDiffOptions) => Promise<string>;
  generateJobId?: () => string;
  availableCommandsTimeoutMs?: number;
}

export interface CodexReviewOptions {
  profile: string;
  profileEntry: unknown;
  workspaceRoot: string;
  host: string;
  hostSessionId: string;
  baseRef?: string | null;
  diff?: string;
  kind?: string;
  prompt?: string;
  label?: string;
  reviewOfJobId?: string | null;
  json?: boolean;
  authority?: JobAuthority;
  availableCommandsTimeoutMs?: number | null;
  deps?: CodexReviewDeps;
}

export async function runCodexReview({
  profile,
  profileEntry,
  workspaceRoot,
  host,
  hostSessionId,
  baseRef = null,
  diff: suppliedDiff,
  kind = "review",
  prompt: suppliedPrompt,
  label,
  reviewOfJobId = null,
  json = false,
  authority = { ...DEFAULT_JOB_AUTHORITY },
  availableCommandsTimeoutMs: timeoutOverride = null,
  deps = {},
}: CodexReviewOptions): Promise<NullOutputResult> {
  const output = createOutput(deps);
  const now = deps.now ?? (() => new Date().toISOString());
  const generateJobId = deps.generateJobId ?? defaultGenerateJobId;
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const getDiff = deps.getDiff ?? defaultGetDiff;
  const slash = `/${kind}`;

  let diff: string;
  try {
    diff =
      suppliedDiff ??
      (await getDiff(baseRef ? { baseRef, cwd: workspaceRoot } : { cwd: workspaceRoot }));
  } catch (error) {
    output.stderr(`${pinnedDiffErrorMessage(error)}\n`);
    return output.result(2);
  }
  const jobId = generateJobId();
  const jobRecord = createQueuedJobRecord({
    jobId,
    kind,
    submittedAt: now(),
    chainId: jobId,
    parentJobId: null,
    delegationDepth: 0,
    authority,
    mode: "read-only",
    host,
    hostSessionId,
    profile,
    label,
    prompt: slash,
    includeDiff: true,
    baseRef: baseRef as string | undefined,
    reviewOfJobId: reviewOfJobId ?? undefined,
  });
  await writeJobRecord(workspaceRoot, jobId, jobRecord);

  let advertisedCommands: Array<{ name: string }> | null = null;
  let advertiseResolve!: (commands: Array<{ name: string }>) => void;
  const advertised = new Promise<Array<{ name: string }>>((resolve) => {
    advertiseResolve = resolve;
  });

  try {
    const result = await runPromptTurn({
      workspaceRoot,
      profileEntry,
      jobRecord,
      prompt: appendPinnedDiff(suppliedPrompt ?? slash, diff, {
        baseRef: reviewOfJobId ? `isolated Job ${reviewOfJobId}` : baseRef,
      }),
      payloadFields: { baseRef },
      deps,
      output,
      renderUpdate: json
        ? () => ""
        : (renderSessionUpdate as (notification: unknown) => string),
      onUpdate(notification) {
        const update =
          (notification as { update?: Record<string, unknown> }).update ??
          (notification as Record<string, unknown>);
        if ((update as Record<string, unknown>).sessionUpdate === "available_commands_update") {
          advertisedCommands =
            ((update as Record<string, unknown>).availableCommands as Array<{ name: string }>) ??
            [];
          advertiseResolve(advertisedCommands);
        }
      },
      afterAccepted: async ({ client }) => {
        const commands = await waitForAvailableCommands(
          advertised,
          resolveAvailableCommandsTimeoutMs(deps, timeoutOverride),
        );
        if (!commands.some((command) => command.name === kind || command.name === slash)) {
          try {
            await client.request("consult/cancel", { jobId });
          } catch {
            // best effort: do not mask the advertise failure with a cancel error
          }
          output.stderr(
            `codex did not advertise ${slash}; the codex-acp version may not support it\n`,
          );
          return output.result(8);
        }
        return null;
      },
    });
    if (Number.isInteger((result as Partial<NullOutputResult>).exitCode)) {
      return result as NullOutputResult;
    }
    const { finalNotification, finalText } = result as {
      finalNotification: { stopReason: string };
      finalText: string;
    };
    if (json) {
      output.stdout(
        `${JSON.stringify(
          jobResultEnvelope(jobRecord, {
            logPath: jobLogPath(workspaceRoot, jobId),
          }),
        )}\n`,
      );
    } else {
      const prefix = finalText.length > 0 && !finalText.endsWith("\n") ? "\n" : "";
      output.stdout(
        `${prefix}consult ${kind} ${jobId} ${statusFromStopReason(
          finalNotification.stopReason,
        )}\n`,
      );
    }
    return output.result(
      statusFromStopReason(finalNotification.stopReason) === "failed" ? 6 : 0,
    );
  } catch (error) {
    output.stderr(`${brokerErrorMessage(error as { code?: string; message: string })}\n`);
    return output.result(1);
  }
}

function resolveAvailableCommandsTimeoutMs(
  deps: CodexReviewDeps,
  timeoutOverride: number | null,
): number {
  if (timeoutOverride !== null) {
    return timeoutOverride;
  }
  if (deps.availableCommandsTimeoutMs !== undefined) {
    return deps.availableCommandsTimeoutMs;
  }
  return Number(process.env.CONSULT_AVAILABLE_COMMANDS_TIMEOUT_MS ?? 2000);
}

function waitForAvailableCommands(
  advertised: Promise<Array<{ name: string }>>,
  timeoutMs: number,
): Promise<Array<{ name: string }>> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    advertised,
    new Promise<Array<{ name: string }>>((resolve) => {
      timeout = setTimeout(() => resolve([]), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}
