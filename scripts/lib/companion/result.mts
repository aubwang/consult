import {
  isFinalStatus,
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import { jobResultEnvelope } from "../job-result-contract.mts";
import { addJobRelationships } from "../delegation-chain.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import type { ParsedArgs } from "../args.mts";
import type { CommandResult } from "./output.mts";

export interface ResultDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
}

export interface RunResultOptions {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: ResultDeps;
}

export async function run(subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runResult({ args: parsedArgs });
}

export async function runResult({ args, deps = {} }: RunResultOptions): Promise<CommandResult> {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }
  let record;
  try {
    record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
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
      stdout: `${JSON.stringify(
        jobResultEnvelope(record, {
          childJobIds: addJobRelationships(record, records).childJobIds,
          logPath: jobLogPath(workspaceRoot, jobId),
        }),
      )}\n`,
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: record.finalText ?? "",
    stderr: "",
  };
}
