import { boolFlag, unsupportedFlagError, type ParsedArgs } from "../args.mts";
import { addJobRelationships } from "../delegation-chain.mts";
import {
  isFinalStatus,
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
  type JobRecord,
} from "../job-records.mts";
import {
  JOB_RESULT_SCHEMA_VERSION,
  jobResultPayload,
} from "../job-result-contract.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { runCancel } from "./cancel.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import type { CommandResult } from "./output.mts";
import { briefText } from "./brief-text.mts";

export interface WaitDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  listJobRecords?: (workspaceRoot: string) => Promise<JobRecord[]>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  signal?: AbortSignal;
  interruptExitCode?: () => number;
  cancelJob?: (workspaceRoot: string, jobId: string) => Promise<CommandResult>;
}

export interface RunWaitOptions {
  args: ParsedArgs;
  deps?: WaitDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  const controller = new AbortController();
  let exitCode = 130;
  const onSigint = () => {
    exitCode = 130;
    controller.abort();
  };
  const onSigterm = () => {
    exitCode = 143;
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    return await runWait({
      args: parsedArgs,
      deps: { signal: controller.signal, interruptExitCode: () => exitCode },
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export async function runWait({ args, deps = {} }: RunWaitOptions): Promise<CommandResult> {
  const unsupported = unsupportedFlagError(args.flags, ["json", "summary", "keep-running"]);
  if (unsupported) {
    return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  }
  if (boolFlag(args.flags?.summary) && boolFlag(args.flags?.json)) {
    return { exitCode: 2, stdout: "", stderr: "--summary is not supported with --json\n" };
  }
  const jobIds = [...new Set(args.positional ?? [])];
  if (jobIds.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "at least one job id is required\n" };
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const readJobRecord = deps.readJobRecord ?? readWorkspaceJobRecord;
  const poll = deps.poll ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const deadline = nowMs() + (deps.maxWaitMs ?? 30 * 60 * 1000);
  let records: JobRecord[];

  while (true) {
    const readResult = await readSelectedJobs(workspaceRoot, jobIds, readJobRecord);
    if ("error" in readResult) {
      return readResult.error;
    }
    records = readResult.records;
    if (records.every((record) => isFinalStatus(record.status))) {
      break;
    }
    if (deps.signal?.aborted) {
      return handleInterrupt({ args, deps, workspaceRoot, jobIds, records });
    }
    if (nowMs() >= deadline) {
      return {
        exitCode: 4,
        stdout: "",
        stderr: `timed out waiting for Jobs: ${jobIds.join(", ")}\n`,
      };
    }
    await poll(200);
    if (deps.signal?.aborted) {
      return handleInterrupt({ args, deps, workspaceRoot, jobIds, records });
    }
  }

  let allRecords: JobRecord[];
  try {
    allRecords = await (deps.listJobRecords ?? listWorkspaceJobRecords)(workspaceRoot);
  } catch (error) {
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
  }
  const payloads = records.map((record, index) => {
    const enriched = addJobRelationships(record, allRecords);
    return jobResultPayload(enriched, {
      childJobIds: enriched.childJobIds,
      logPath: jobLogPath(workspaceRoot, jobIds[index]),
    });
  });

  if (boolFlag(args.flags?.json)) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ schemaVersion: JOB_RESULT_SCHEMA_VERSION, jobs: payloads })}\n`,
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: boolFlag(args.flags?.summary)
      ? renderWaitSummaries(payloads)
      : renderWaitResults(payloads),
    stderr: "",
  };
}

async function handleInterrupt({
  args,
  deps,
  workspaceRoot,
  jobIds,
  records,
}: {
  args: ParsedArgs;
  deps: WaitDeps;
  workspaceRoot: string;
  jobIds: readonly string[];
  records: readonly JobRecord[];
}): Promise<CommandResult> {
  const activeJobIds = records
    .map((record, index) => ({ jobId: jobIds[index], status: record.status }))
    .filter(({ status }) => !isFinalStatus(status))
    .map(({ jobId }) => jobId);
  if (boolFlag(args.flags?.["keep-running"]) || activeJobIds.length === 0) {
    return {
      exitCode: deps.interruptExitCode?.() ?? 130,
      stdout: "",
      stderr: "wait interrupted; active Jobs left running\n",
    };
  }

  const cancelJob =
    deps.cancelJob ??
    ((root: string, jobId: string) =>
      runCancel({
        args: { positional: [jobId], flags: {} },
        deps: { resolveWorkspaceRoot: async () => root },
      }));
  const failures: string[] = [];
  for (const jobId of activeJobIds) {
    try {
      const result = await cancelJob(workspaceRoot, jobId);
      if (result.exitCode !== 0) {
        failures.push(`${jobId}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
    } catch (error) {
      failures.push(`${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const failureSuffix = failures.length > 0 ? `; cancellation errors: ${failures.join("; ")}` : "";
  return {
    exitCode: deps.interruptExitCode?.() ?? 130,
    stdout: "",
    stderr: `wait interrupted; cancellation requested for ${activeJobIds.join(", ")}${failureSuffix}\n`,
  };
}

async function readSelectedJobs(
  workspaceRoot: string,
  jobIds: readonly string[],
  readJobRecord: (workspaceRoot: string, jobId: string) => Promise<JobRecord>,
): Promise<{ records: JobRecord[] } | { error: CommandResult }> {
  const records: JobRecord[] = [];
  for (const jobId of jobIds) {
    try {
      records.push(await readJobRecord(workspaceRoot, jobId));
    } catch (error) {
      return { error: jobLookupErrorResult(error, jobId) };
    }
  }
  return { records };
}

function renderWaitResults(payloads: ReturnType<typeof jobResultPayload>[]): string {
  return `${payloads
    .map((payload) => {
      const detail = payload.outcome.finalText ?? payload.outcome.errorMessage;
      return [
        `${payload.job.id} ${payload.job.status}`,
        ...(detail ? [detail] : []),
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

function renderWaitSummaries(payloads: ReturnType<typeof jobResultPayload>[]): string {
  return `${payloads
    .map((payload) => {
      const detail = payload.outcome.finalText
        ? `result: ${briefText(payload.outcome.finalText)}`
        : payload.outcome.errorMessage
          ? `error: ${briefText(payload.outcome.errorMessage)}`
          : null;
      const fields = [
        `${payload.job.id}${payload.job.label ? ` [${payload.job.label}]` : ""} ${payload.job.status}`,
        detail,
        payload.artifacts.patchPath ? `patch: ${payload.artifacts.patchPath}` : null,
        payload.artifacts.touchedFilesPath
          ? `files: ${payload.artifacts.touchedFilesPath}`
          : null,
      ].filter((field): field is string => field !== null);
      return fields.join(" | ");
    })
    .join("\n")}\n`;
}
