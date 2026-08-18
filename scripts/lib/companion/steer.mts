import {
  invalidBooleanFlagValueError,
  missingFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import type { BrokerClient } from "../broker-client.mts";
import { connectBrokerSession as defaultConnectBrokerSession } from "../broker-lifecycle.mts";
import type { BrokerLifecycleInput } from "../broker-lifecycle.mts";
import { MAX_STEER_GUIDANCE_BYTES } from "../job-steer.mts";
import { JOB_STATUS, isFinalStatus, readWorkspaceJobRecord } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { brokerErrorMessage, exitCodeForBrokerError } from "../prompt-turn-runner.mts";
import { workspaceRootResolver } from "./invocation-context.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import type { CommandResult } from "./output.mts";

const SUPPORTED_FLAGS = ["message"];

// A Job that cannot be steered is not a retryable contention (3) and not a
// malformed invocation (2): it is the same shape of refusal the Broker already
// returns for RESUME_UNSUPPORTED, which exitCodeForBrokerError maps to 1.
const STEER_UNSUPPORTED_EXIT_CODE = 1;

const BROKER_ERROR_EXIT_CODES: Record<string, number> = {
  UNKNOWN_JOB: 2,
  STEER_GUIDANCE_TOO_LARGE: 2,
  JOB_NOT_RUNNING: 5,
  STEER_PENDING: 3,
  STEER_UNSUPPORTED: STEER_UNSUPPORTED_EXIT_CODE,
};

interface CodedError extends Error {
  code?: string;
}

export interface SteerDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  connectBrokerSession?: (args: BrokerLifecycleInput) => Promise<{ client: BrokerClient }>;
}

export interface RunSteerOptions {
  args: ParsedArgs;
  env?: NodeJS.ProcessEnv;
  deps?: SteerDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runSteer({ args: parsedArgs });
}

export async function runSteer({
  args,
  env = process.env,
  deps = {},
}: RunSteerOptions): Promise<CommandResult> {
  const usage = validateFlags(args);
  if (usage) {
    return usageError(usage);
  }
  const jobId = args.positional?.[0];
  if (!jobId) {
    return usageError("job id is required");
  }
  const guidance = resolveGuidance(args);
  if (!guidance) {
    return usageError("guidance is required");
  }
  // Guidance is rejected rather than truncated, mirroring `consult report
  // --data`: a clipped instruction changes what the Job is being told to do.
  const guidanceBytes = Buffer.byteLength(guidance);
  if (guidanceBytes > MAX_STEER_GUIDANCE_BYTES) {
    return usageError(
      `guidance is ${guidanceBytes} bytes; the limit is ${MAX_STEER_GUIDANCE_BYTES}`,
    );
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? workspaceRootResolver(env))();
  let record: JobRecord;
  try {
    record = await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }
  if (!record.host || !record.hostSessionId) {
    return usageError(`invalid job record ${jobId}: missing host identity`);
  }

  // Guidance belongs to a Job's running window for the same reason a report
  // does: outside it there is no turn to steer. Exit 5 is the lifecycle
  // ordering family (ADR-0039).
  const notRunning = notRunningResult(record);
  if (notRunning) {
    return notRunning;
  }
  // Inline runners hold no socket: the foreground companion and an --isolated
  // background Job both run their turn in-process, so nothing can reach the
  // live prompt turn from another process. An isolated Job is checked by its
  // own field too, not only by the runner its worker stamps at pickup.
  if (record.runner === "inline" || record.isolated === true) {
    return {
      exitCode: STEER_UNSUPPORTED_EXIT_CODE,
      stdout: "",
      stderr:
        `steer is not available for job ${jobId} (inline runner); ` +
        "cancel and re-delegate with the guidance in the prompt\n",
    };
  }

  let client: BrokerClient;
  try {
    ({ client } = await (deps.connectBrokerSession ?? defaultConnectBrokerSession)({
      workspaceRoot,
      jobId,
      host: record.host,
      hostSessionId: record.hostSessionId,
      profile: record.profile,
    }));
  } catch (error) {
    return brokerErrorResult(error);
  }

  try {
    await client.request("consult/steer", { jobId, guidance });
  } catch (error) {
    return brokerErrorResult(error);
  } finally {
    await client.close?.().catch(() => {});
  }

  return { exitCode: 0, stdout: `steered ${jobId}\n`, stderr: "" };
}

function notRunningResult(record: JobRecord): CommandResult | null {
  if (record.status === JOB_STATUS.RUNNING) {
    return null;
  }
  const reason = isFinalStatus(record.status)
    ? "job already finalized; cannot steer"
    : "job not running yet; cannot steer";
  return { exitCode: 5, stdout: "", stderr: `${reason} (status=${record.status})\n` };
}

function brokerErrorResult(error: unknown): CommandResult {
  const coded = error as CodedError;
  const exitCode =
    BROKER_ERROR_EXIT_CODES[coded.code as string] ?? exitCodeForBrokerError(coded.code);
  return {
    exitCode,
    stdout: "",
    stderr: `${brokerErrorMessage({ code: coded.code, message: coded.message })}\n`,
  };
}

function validateFlags(args: ParsedArgs): string | null {
  return (
    unsupportedFlagError(args.flags, SUPPORTED_FLAGS) ??
    invalidBooleanFlagValueError(args.flags) ??
    missingFlagValueError(args.flags, SUPPORTED_FLAGS)
  );
}

function resolveGuidance(args: ParsedArgs): string {
  return (
    stringFlag(args.flags?.message) || (args.positional ?? []).slice(1).join(" ").trim()
  );
}

function usageError(message: string): CommandResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}
