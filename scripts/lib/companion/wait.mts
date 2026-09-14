import { readBatch } from "../job-batch.mts";
import { resolveHostIdentity } from "../host-identity.mts";
import { boolFlag, stringFlag, missingFlagValueError, unsupportedFlagError, type ParsedArgs } from "../args.mts";
import { indexJobRelationships } from "../delegation-chain.mts";
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
import { briefText, outputPreview } from "./brief-text.mts";

export interface WaitDeps {
  stderrWrite?: (text: string) => void;
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
  const unsupported = unsupportedFlagError(args.flags, ["json", "summary", "keep-running", "batch", "any", "watch", "timeout", "active", "host", "host-session"]);
  if (unsupported) {
    return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  }
  if (boolFlag(args.flags?.summary) && boolFlag(args.flags?.json)) {
    return { exitCode: 2, stdout: "", stderr: "--summary is not supported with --json\n" };
  }
  const missing = missingFlagValueError(args.flags, ["batch", "timeout", "host", "host-session"]);
  if (missing) return { exitCode: 2, stdout: "", stderr: `${missing}\n` };
  const timeout = stringFlag(args.flags.timeout);
  if (timeout !== undefined && (!/^\d+$/u.test(timeout) || Number(timeout) > 1800)) return { exitCode: 2, stdout: "", stderr: "--timeout must be 0-1800 seconds\n" };
  const batchId = stringFlag(args.flags.batch);
  const active = boolFlag(args.flags.active);
  if ((batchId && active) || ((batchId || active) && args.positional.length)) return { exitCode: 2, stdout: "", stderr: "choose Job ids, --batch, or --active\n" };
  let jobIds = [...new Set(args.positional ?? [])];
  if (jobIds.length === 0 && !batchId && !active) {
    return { exitCode: 2, stdout: "", stderr: "at least one job id is required\n" };
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  let batchWarning = "";
  if (batchId) {
    try {
      const batch = await readBatch(workspaceRoot, batchId);
      if (!batch.submitted) batchWarning = `batch submission incomplete: ${batch.error ?? "still submitting"}; waiting only for recorded Job ids\n`;
      jobIds = batch.jobIds;
    } catch (error) { return { exitCode: 2, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` }; }
  }
  if (active) {
    const host = resolveHostIdentity({ args });
    jobIds = (await (deps.listJobRecords ?? listWorkspaceJobRecords)(workspaceRoot))
      .filter((record) => record.host === host.host && record.hostSessionId === host.hostSessionId && !isFinalStatus(record.status))
      .map((record) => record.jobId!).filter(Boolean);
  }
  const readJobRecord = deps.readJobRecord ?? readWorkspaceJobRecord;
  const poll = deps.poll ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const deadline = nowMs() + (timeout !== undefined ? Number(timeout) * 1000 : deps.maxWaitMs ?? 30 * 60 * 1000);
  let records: JobRecord[];
  let previous = "";

  while (true) {
    const readResult = await readSelectedJobs(workspaceRoot, jobIds, readJobRecord);
    if ("error" in readResult) {
      return readResult.error;
    }
    records = readResult.records;
    if (boolFlag(args.flags.watch)) {
      const snapshot = records.map((record) => `${record.jobId} ${record.status}${record.label ? ` [${briefText(record.label)}]` : ""}`).join("\n");
      if (snapshot !== previous) (deps.stderrWrite ?? ((text) => process.stderr.write(text)))(`${snapshot}\n`);
      previous = snapshot;
    }
    if (records.every((record) => isFinalStatus(record.status)) || (boolFlag(args.flags.any) && records.some((record) => isFinalStatus(record.status)))) {
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

  const warnings: string[] = batchWarning ? [batchWarning] : [];
  let allRecords: JobRecord[];
  try {
    allRecords = await (deps.listJobRecords ?? ((root: string) => listWorkspaceJobRecords(root, {
      onMalformed: (error) => warnings.push(`Skipped malformed history record: ${error.path}; relationships may be incomplete\n`),
    })))(workspaceRoot);
  } catch (error) {
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
  }
  const children = indexJobRelationships(allRecords);
  const payloads = records.map((record, index) => {
    return jobResultPayload(record, {
      childJobIds: children.get(record.jobId ?? "") ?? [],
      logPath: jobLogPath(workspaceRoot, jobIds[index]),
    });
  });

  if (boolFlag(args.flags?.json)) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ schemaVersion: JOB_RESULT_SCHEMA_VERSION, jobs: payloads })}\n`,
      stderr: warnings.join(""),
    };
  }
  return {
    exitCode: 0,
    stdout: boolFlag(args.flags?.summary)
      ? renderWaitSummaries(payloads)
      : renderWaitResults(payloads),
    stderr: warnings.join(""),
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
        ? `output preview: ${outputPreview(payload.outcome.finalText)}`
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
