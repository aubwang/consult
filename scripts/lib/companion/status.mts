import fs from "node:fs/promises";

import { addJobRelationships } from "../delegation-chain.mts";
import {
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { briefText } from "./brief-text.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import { pollUntilFinalRecord } from "./job-poll.mts";
import { runLogs } from "./logs.mts";
import type { CommandResult, OutputDeps } from "./output.mts";
import type { ParsedArgs } from "../args.mts";

export interface StatusDeps extends OutputDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
}

interface WaitTimeoutError extends Error {
  code: string;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runStatus({ args: parsedArgs });
}

export async function runStatus({
  args,
  deps = {},
}: {
  args: ParsedArgs;
  deps?: StatusDeps;
}): Promise<CommandResult> {
  if (args.flags?.follow !== undefined) {
    if (!args.positional?.[0]) {
      return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
    }
    return runLogs({ args: { ...args, flags: { ...args.flags, follow: true } }, deps });
  }
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (jobId) {
    let record: JobRecord;
    try {
      record = args.flags?.wait
        ? await waitForFinalRecord(workspaceRoot, jobId, deps)
        : await readWorkspaceJobRecord(workspaceRoot, jobId);
    } catch (error) {
      if ((error as WaitTimeoutError).code === "WAIT_TIMEOUT") {
        return { exitCode: 4, stdout: "", stderr: `${(error as Error).message}\n` };
      }
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
    const enrichedRecord = addJobRelationships(record, records);
    if (args.flags?.json) {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          record: enrichedRecord,
          logTail: await readLogTail(workspaceRoot, jobId),
        })}\n`,
        stderr: "",
      };
    }
    const lines = [
      JSON.stringify(enrichedRecord, null, 2),
      "",
      "log tail:",
      ...(await readLogTail(workspaceRoot, jobId)),
    ];
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
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
  const enrichedRecords = records.map((record) => addJobRelationships(record, records));
  return {
    exitCode: 0,
    stdout: args.flags?.json
      ? `${JSON.stringify(enrichedRecords)}\n`
      : renderJobTable(enrichedRecords),
    stderr: "",
  };
}

async function waitForFinalRecord(
  workspaceRoot: string,
  jobId: string,
  deps: StatusDeps,
): Promise<JobRecord> {
  return pollUntilFinalRecord({
    readRecord: () => readWorkspaceJobRecord(workspaceRoot, jobId),
    maxWaitMs: deps.maxWaitMs,
    poll: deps.poll,
    timeoutCode: "WAIT_TIMEOUT",
    timeoutMessage: `timed out waiting for job ${jobId}`,
  });
}

async function readLogTail(workspaceRoot: string, jobId: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await fs.readFile(jobLogPath(workspaceRoot, jobId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return contents.trimEnd().split("\n").slice(-20);
}

function renderJobTable(records: Array<JobRecord & { childJobIds: string[] }>): string {
  const lines = [
    "jobId\tprofile\tstatus\tdepth\tparentJobId\tchildren\tsubmittedAt\tcompletedAt\tprompt",
  ];
  if (records.length === 0) {
    lines.push("(no jobs)");
  } else {
    for (const record of records) {
      lines.push(
        [
          record.jobId,
          record.profile ?? "-",
          record.status ?? "-",
          record.delegationDepth ?? "-",
          record.parentJobId ?? "-",
          record.childJobIds?.length ? record.childJobIds.join(",") : "-",
          record.submittedAt ?? "-",
          record.completedAt ?? "-",
          briefText(record.prompt ?? ""),
        ].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
