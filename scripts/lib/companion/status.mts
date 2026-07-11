import { addJobRelationships } from "../delegation-chain.mts";
import {
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import {
  JOB_RESULT_SCHEMA_VERSION,
  jobResultEnvelope,
  jobResultPayload,
} from "../job-result-contract.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { briefText } from "./brief-text.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import { pollUntilFinalRecord } from "./job-poll.mts";
import { runLogs } from "./logs.mts";
import type { CommandResult, OutputDeps } from "./output.mts";
import { boolFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";

const DEFAULT_STATUS_JOB_LIMIT = 20;

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
          ...jobResultEnvelope(enrichedRecord, {
            childJobIds: enrichedRecord.childJobIds,
            logPath: jobLogPath(workspaceRoot, jobId),
          }),
        })}\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: renderJobSummary(enrichedRecord),
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
  const visibleRecords = boolFlag(args.flags?.all)
    ? enrichedRecords
    : enrichedRecords.slice(0, DEFAULT_STATUS_JOB_LIMIT);
  return {
    exitCode: 0,
    stdout: args.flags?.json
      ? `${JSON.stringify({
          schemaVersion: JOB_RESULT_SCHEMA_VERSION,
          jobs: visibleRecords.map((record) =>
            jobResultPayload(record, {
              childJobIds: record.childJobIds,
              logPath:
                typeof record.jobId === "string"
                  ? jobLogPath(workspaceRoot, record.jobId)
                  : null,
            }),
          ),
        })}\n`
      : renderJobTable(visibleRecords),
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

function renderJobTable(records: Array<JobRecord & { childJobIds: string[] }>): string {
  const lines = [
    "jobId\tlabel\tprofile\tstatus\tdepth\tparentJobId\tchildren\tsubmittedAt\tcompletedAt\tprompt",
  ];
  if (records.length === 0) {
    lines.push("(no jobs)");
  } else {
    for (const record of records) {
      lines.push(
        [
          record.jobId,
          record.label ?? "-",
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

function renderJobSummary(record: JobRecord & { childJobIds: string[] }): string {
  const lines = [
    `jobId: ${record.jobId}`,
  ];
  if (record.label) lines.push(`label: ${record.label}`);
  lines.push(`profile: ${record.profile ?? "-"}`, `status: ${record.status ?? "-"}`);
  for (const [label, value] of [
    ["submittedAt", record.submittedAt],
    ["startedAt", record.startedAt],
    ["completedAt", record.completedAt],
  ] as const) {
    if (value) lines.push(`${label}: ${value}`);
  }
  if (record.prompt) lines.push(`prompt: ${briefText(record.prompt)}`);
  if (record.errorMessage) lines.push(`error: ${briefText(record.errorMessage)}`);
  if (record.finalText) lines.push(`result: ${briefText(record.finalText)}`);
  lines.push(`children: ${record.childJobIds.length ? record.childJobIds.join(",") : "-"}`);
  return `${lines.join("\n")}\n`;
}
