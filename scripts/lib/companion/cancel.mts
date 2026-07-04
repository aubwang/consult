import type { BrokerClient } from "../broker-client.mts";
import { connectBrokerSession as defaultConnectBrokerSession } from "../broker-lifecycle.mts";
import type { BrokerLifecycleInput } from "../broker-lifecycle.mts";
import { cancelCascadeRecordTargets } from "../delegation-chain.mts";
import {
  finalizeJobRecord,
  isFinalStatus,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
  writeJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { pidMatchesStartTime as defaultPidMatchesStartTime } from "../process-identity.mts";
import {
  pidIsAlive as defaultPidIsAlive,
  terminateProcessTree as defaultTerminateProcessTree,
} from "../process.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import type { CliResult } from "./job-record-errors.mts";

interface CancelDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  connectBrokerSession?: (args: BrokerLifecycleInput) => Promise<{ client: BrokerClient }>;
  pidIsAlive?: (pid: number) => boolean;
  pidMatchesStartTime?: (
    pid: number,
    expectedStartTime: string | null | undefined,
  ) => Promise<boolean>;
  terminateProcessTree?: (pid: number) => Promise<void>;
  signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => string;
}

interface RunCancelOptions {
  args: { positional?: string[]; flags?: Record<string, unknown> };
  env?: NodeJS.ProcessEnv;
  deps?: CancelDeps;
}

export async function run(
  subcommand: string,
  parsedArgs: RunCancelOptions["args"],
): Promise<CliResult> {
  return runCancel({ args: parsedArgs });
}

export async function runCancel({
  args,
  env = process.env,
  deps = {},
}: RunCancelOptions): Promise<CliResult> {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }
  let record: JobRecord;
  try {
    record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }
  let records: JobRecord[];
  try {
    records = await listWorkspaceJobRecords(workspaceRoot);
  } catch (error) {
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
  }
  const { activeDescendants, targets } = cancelCascadeRecordTargets(record, records, {
    isFinalStatus,
  });
  if (isFinalStatus(record.status) && activeDescendants.length === 0) {
    return {
      exitCode: 0,
      stdout: `already finalized (status=${record.status})\n`,
      stderr: "",
    };
  }

  let stdout =
    isFinalStatus(record.status) && activeDescendants.length > 0
      ? `already finalized (status=${record.status}); cancelling ${activeDescendants.length} active descendant(s)\n`
      : "";

  for (const target of targets) {
    const result = await cancelOneRecord({ workspaceRoot, jobId: target.jobId, record: target, deps });
    if (result.exitCode !== 0) {
      return { ...result, stdout: stdout + result.stdout };
    }
    stdout += target.jobId === jobId ? result.stdout : `cascade ${target.jobId}: ${result.stdout}`;
  }

  return { exitCode: 0, stdout, stderr: "" };
}

async function cancelOneRecord({
  workspaceRoot,
  jobId,
  record,
  deps,
}: {
  workspaceRoot: string;
  jobId: string | undefined;
  record: JobRecord;
  deps: CancelDeps;
}): Promise<CliResult> {
  if (!record.host || !record.hostSessionId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `invalid job record ${jobId}: missing host identity\n`,
    };
  }
  if (record.runner === "inline") {
    return await cancelInlineJob({ workspaceRoot, jobId, record, deps });
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
    if (
      (error as NodeJS.ErrnoException).code === "BROKER_UNREACHABLE" ||
      (error as NodeJS.ErrnoException).code === "BROKER_STATE_MALFORMED" ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await markCancelledAtCancelTime({ workspaceRoot, jobId, record, deps });
      const workerOutput = await terminateWorkerIfAlive(record, deps);
      return {
        exitCode: 0,
        stdout:
          "broker not running -- job is presumably orphaned; record marked cancelled\n" +
          "inspect Broker state with `consult brokers`; remove stale state with `consult brokers --cleanup`\n" +
          workerOutput,
        stderr: "",
      };
    }
    throw error;
  }
  const cancelResult = await client.request("consult/cancel", { jobId });
  const workerOutput = await terminateWorkerIfAlive(record, deps);
  return { exitCode: 0, stdout: `${JSON.stringify(cancelResult)}\n${workerOutput}`, stderr: "" };
}

async function cancelInlineJob({
  workspaceRoot,
  jobId,
  record,
  deps,
}: {
  workspaceRoot: string;
  jobId: string | undefined;
  record: JobRecord;
  deps: CancelDeps;
}): Promise<CliResult> {
  const runnerPid = record.runnerPid;
  const pidIsAlive = deps.pidIsAlive ?? defaultPidIsAlive;
  const pidMatchesStartTime = deps.pidMatchesStartTime ?? defaultPidMatchesStartTime;
  let runnerLive = Number.isInteger(runnerPid) && pidIsAlive(runnerPid as number);
  if (runnerLive && record.runnerStartTime) {
    // A stale record can point at a reused pid; only signal the companion
    // process that actually stamped this record.
    runnerLive = await pidMatchesStartTime(runnerPid as number, record.runnerStartTime);
  }
  if (runnerLive) {
    try {
      // A plain SIGTERM (not a tree kill): the companion's inline signal handler
      // sends session/cancel, settles the record, and disposes the agent.
      (deps.signalPid ?? defaultSignalPid)(runnerPid as number, "SIGTERM");
      return {
        exitCode: 0,
        stdout: `inline runner pid ${runnerPid} signalled; job will finalize as cancelled\n`,
        stderr: "",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `cannot signal inline runner pid ${runnerPid}: permission denied (pid likely reused)\n`,
        };
      }
      if (code !== "ESRCH") {
        throw error;
      }
      // The runner died between the liveness check and the signal; fall
      // through and settle the record here.
    }
  }
  await markCancelledAtCancelTime({
    workspaceRoot,
    jobId,
    record,
    deps,
    errorMessage: "inline runner not running at cancel time",
  });
  return {
    exitCode: 0,
    stdout: "inline runner not running -- job is presumably orphaned; record marked cancelled\n",
    stderr: "",
  };
}

function defaultSignalPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

async function markCancelledAtCancelTime({
  workspaceRoot,
  jobId,
  record,
  deps,
  errorMessage = "broker not running at cancel time",
}: {
  workspaceRoot: string;
  jobId: string | undefined;
  record: JobRecord;
  deps: CancelDeps;
  errorMessage?: string;
}): Promise<void> {
  finalizeJobRecord(record, {
    now: deps.now,
    stopReason: "cancelled",
    errorMessage,
  });
  await writeJobRecord(workspaceRoot, jobId as string, record);
}

async function terminateWorkerIfAlive(record: JobRecord, deps: CancelDeps): Promise<string> {
  const workerPid = record.workerPid;
  if (!Number.isInteger(workerPid)) {
    return "";
  }
  const pidIsAlive = deps.pidIsAlive ?? defaultPidIsAlive;
  const terminateProcessTree = deps.terminateProcessTree ?? defaultTerminateProcessTree;
  if (!pidIsAlive(workerPid as number)) {
    return "";
  }
  try {
    await terminateProcessTree(workerPid as number);
    return `worker pid ${workerPid} terminated\n`;
  } catch {
    return "";
  }
}
