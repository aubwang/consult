import { getDiff as defaultGetDiff } from "../lib/git.mts";
import type { GetDiffOptions } from "../lib/git.mts";
import {
  createQueuedJobRecord,
  writeJobRecord as defaultWriteJobRecord,
} from "../lib/job-records.mts";
import { defaultGenerateJobId } from "../lib/job-ids.mts";
import { runPromptTurn, brokerErrorMessage } from "../lib/prompt-turn-runner.mts";
import type { PromptTurnDeps } from "../lib/prompt-turn-runner.mts";
import { createOutput } from "../lib/companion/output.mts";
import type { OutputDeps } from "../lib/companion/output.mts";
import { renderSessionUpdate } from "../lib/session-update-renderer.mts";
import type { NullOutputResult } from "../lib/null-output.mts";

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
  kind?: string;
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
  kind = "review",
  availableCommandsTimeoutMs: timeoutOverride = null,
  deps = {},
}: CodexReviewOptions): Promise<NullOutputResult> {
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
    baseRef: baseRef as string | undefined,
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
      prompt: `${slash}\n\n${diff}`,
      payloadFields: { baseRef },
      deps,
      output,
      renderUpdate: renderSessionUpdate as (notification: unknown) => string,
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
    if (Number.isInteger((result as Partial<NullOutputResult>).exitCode)) {
      return result as NullOutputResult;
    }
  } catch (error) {
    output.stderr(`${brokerErrorMessage(error as { code?: string; message: string })}\n`);
    return output.result(1);
  }
  return output.result(0);
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
