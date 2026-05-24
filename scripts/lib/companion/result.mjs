import {
  isFinalStatus,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mjs";
import { addJobRelationships } from "../delegation-chain.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";

export async function run(subcommand, parsedArgs) {
  return runResult({ args: parsedArgs });
}

export async function runResult({ args, deps = {} }) {
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
  if (!isFinalStatus(record.status)) {
    return {
      exitCode: 5,
      stdout: "",
      stderr: `job not finished; current status: ${record.status}\n`,
    };
  }
  if (args.flags?.json) {
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
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(addJobRelationships(record, records))}\n`,
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: record.finalText ?? "",
    stderr: "",
  };
}
