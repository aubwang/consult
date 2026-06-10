import type { BrokerClient } from "../broker-client.mts";
import { connectBrokerSession as defaultConnectBrokerSession } from "../broker-lifecycle.mts";
import type { BrokerLifecycleInput } from "../broker-lifecycle.mts";
import { cancelCascadeRecordTargets } from "../delegation-chain.mts";
import {
  failJobRecord,
  isFinalStatus,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
  writeJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import {
  pidIsAlive as defaultPidIsAlive,
  terminateProcessTree as defaultTerminateProcessTree,
} from "../process.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { jobRecordErrorResult } from "./job-record-errors.mts";
import type { CliResult } from "./job-record-errors.mts";

interface CancelDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  connectBrokerSession?: (args: BrokerLifecycleInput) => Promise<{ client: BrokerClient }>;
  pidIsAlive?: (pid: number) => boolean;
  terminateProcessTree?: (pid: number) => Promise<void>;
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exitCode: 2, stdout: "", stderr: `job not found: ${jobId}\n` };
    }
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
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
      return result;
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
      await markFailedAtCancelTime({ workspaceRoot, jobId, record, deps });
      const workerOutput = await terminateWorkerIfAlive(record, deps);
      return {
        exitCode: 0,
        stdout:
          "broker not running -- job is presumably orphaned; record marked failed\n" +
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

async function markFailedAtCancelTime({
  workspaceRoot,
  jobId,
  record,
  deps,
}: {
  workspaceRoot: string;
  jobId: string | undefined;
  record: JobRecord;
  deps: CancelDeps;
}): Promise<void> {
  failJobRecord(record, {
    now: deps.now,
    errorMessage: "broker not running at cancel time",
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
