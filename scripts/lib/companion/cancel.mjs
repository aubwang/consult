import { connectBrokerSession as defaultConnectBrokerSession } from "../broker-lifecycle.mjs";
import { cancelCascadeRecordTargets } from "../delegation-chain.mjs";
import {
  failJobRecord,
  isFinalStatus,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
  writeJobRecord,
} from "../job-records.mjs";
import {
  pidIsAlive as defaultPidIsAlive,
  terminateProcessTree as defaultTerminateProcessTree,
} from "../process.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";

export async function run(subcommand, parsedArgs) {
  return runCancel({ args: parsedArgs });
}

export async function runCancel({ args, env = process.env, deps = {} }) {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }
  let record;
  try {
    record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exitCode: 2, stdout: "", stderr: `job not found: ${jobId}\n` };
    }
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
  }
  let records;
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

async function cancelOneRecord({ workspaceRoot, jobId, record, deps }) {
  if (!record.host || !record.hostSessionId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `invalid job record ${jobId}: missing host identity\n`,
    };
  }
  let client;
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
      error.code === "BROKER_UNREACHABLE" ||
      error.code === "BROKER_STATE_MALFORMED" ||
      error.code === "ENOENT"
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

async function markFailedAtCancelTime({ workspaceRoot, jobId, record, deps }) {
  failJobRecord(record, {
    now: deps.now,
    errorMessage: "broker not running at cancel time",
  });
  await writeJobRecord(workspaceRoot, jobId, record);
}

async function terminateWorkerIfAlive(record, deps) {
  const workerPid = record.workerPid;
  if (!Number.isInteger(workerPid)) {
    return "";
  }
  const pidIsAlive = deps.pidIsAlive ?? defaultPidIsAlive;
  const terminateProcessTree = deps.terminateProcessTree ?? defaultTerminateProcessTree;
  if (!pidIsAlive(workerPid)) {
    return "";
  }
  try {
    await terminateProcessTree(workerPid);
    return `worker pid ${workerPid} terminated\n`;
  } catch {
    return "";
  }
}
