import { addJobRelationships } from "../delegation-chain.mts";
import {
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import {
  JOB_RESULT_SCHEMA_VERSION,
  jobResultPayload,
} from "../job-result-contract.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import type { ParsedArgs } from "../args.mts";
import { briefText } from "./brief-text.mts";
import type { CommandResult } from "./output.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";

export interface ChainDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  listJobRecords?: (workspaceRoot: string) => Promise<JobRecord[]>;
}

export interface RunChainOptions {
  args: ParsedArgs;
  deps?: ChainDeps;
}

interface ChainRollup {
  requestedJobId: string;
  chainId: string | null;
  rootJobId: string | null;
  parentJobId: string | null;
  childJobIds: string[];
}

interface ChainRecord {
  jobId: string | null;
  relations: string[];
  status: string | null;
  profile: string | null;
  parentJobId: string | null;
  childJobIds: string[];
  delegationDepth: number | null;
  prompt: string | null;
  finalText: string | null;
}

type EnrichedJobRecord = JobRecord & { childJobIds: string[] };

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runChain({ args: parsedArgs });
}

export async function runChain({ args, deps = {} }: RunChainOptions): Promise<CommandResult> {
  const jobId = args.positional?.[0];
  if (!jobId) {
    return { exitCode: 2, stdout: "", stderr: "job id is required\n" };
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  let requestedRecord: JobRecord;
  try {
    requestedRecord = await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
  } catch (error) {
    return jobLookupErrorResult(error, jobId);
  }

  let records: JobRecord[];
  try {
    records = await (deps.listJobRecords ?? listWorkspaceJobRecords)(workspaceRoot);
  } catch (error) {
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      return malformedResult;
    }
    throw error;
  }

  const enrichedRecords = chainRecords(requestedRecord, records).map((record) =>
    addJobRelationships(record, records),
  );
  const enrichedRequested = addJobRelationships(requestedRecord, records);
  const rollup = chainRollup(enrichedRequested, enrichedRecords);
  const chainRecordRows = enrichedRecords.map((record) => chainRecord(record, rollup, jobId));

  if (args.flags?.json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: JOB_RESULT_SCHEMA_VERSION,
        chain: rollup,
        jobs: enrichedRecords.map((record) => ({
          ...jobResultPayload(record, {
            childJobIds: record.childJobIds,
            logPath:
              typeof record.jobId === "string"
                ? jobLogPath(workspaceRoot, record.jobId)
                : null,
          }),
          relations: recordRelations(record, rollup, jobId),
        })),
      })}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: renderChainTable(rollup, chainRecordRows),
    stderr: "",
  };
}

function chainRecords(requestedRecord: JobRecord, records: JobRecord[]): JobRecord[] {
  const chainId = requestedRecord.chainId ?? requestedRecord.jobId;
  const matches = records.filter(
    (record) => record.jobId === chainId || record.chainId === chainId,
  );
  if (matches.some((record) => record.jobId === requestedRecord.jobId)) {
    return matches.sort(compareChainRecords);
  }
  return [requestedRecord, ...matches].sort(compareChainRecords);
}

function compareChainRecords(left: JobRecord, right: JobRecord): number {
  const leftDepth = Number.isInteger(left.delegationDepth) ? (left.delegationDepth as number) : 0;
  const rightDepth = Number.isInteger(right.delegationDepth) ? (right.delegationDepth as number) : 0;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }
  const submitted = String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? ""));
  if (submitted !== 0) {
    return submitted;
  }
  return String(left.jobId ?? "").localeCompare(String(right.jobId ?? ""));
}

function chainRollup(
  requestedRecord: EnrichedJobRecord,
  records: EnrichedJobRecord[],
): ChainRollup {
  const chainId = requestedRecord.chainId ?? requestedRecord.jobId ?? null;
  const root =
    records.find((record) => record.jobId === chainId) ??
    records.find((record) => record.parentJobId === null) ??
    records.find((record) => record.delegationDepth === 0) ??
    null;
  return {
    requestedJobId: requestedRecord.jobId ?? "",
    chainId,
    rootJobId: root?.jobId ?? null,
    parentJobId: requestedRecord.parentJobId ?? null,
    childJobIds: requestedRecord.childJobIds,
  };
}

function chainRecord(record: EnrichedJobRecord, rollup: ChainRollup, requestedJobId: string): ChainRecord {
  return {
    jobId: record.jobId ?? null,
    relations: recordRelations(record, rollup, requestedJobId),
    status: record.status ?? null,
    profile: record.profile ?? null,
    parentJobId: record.parentJobId ?? null,
    childJobIds: record.childJobIds,
    delegationDepth: Number.isInteger(record.delegationDepth) ? (record.delegationDepth as number) : null,
    prompt: record.prompt ?? null,
    finalText: record.finalText ?? null,
  };
}

function recordRelations(record: EnrichedJobRecord, rollup: ChainRollup, requestedJobId: string): string[] {
  const relations: string[] = [];
  if (record.jobId === rollup.rootJobId) {
    relations.push("root");
  }
  if (record.jobId === rollup.parentJobId) {
    relations.push("parent");
  }
  if (record.jobId === requestedJobId) {
    relations.push("target");
  }
  if (rollup.childJobIds.includes(record.jobId ?? "")) {
    relations.push("child");
  }
  if (relations.length === 0) {
    relations.push("chain");
  }
  return relations;
}

function renderChainTable(rollup: ChainRollup, records: ChainRecord[]): string {
  const lines = [
    `chain\t${rollup.chainId ?? "-"}\tjob\t${rollup.requestedJobId}\troot\t${rollup.rootJobId ?? "-"}\tparent\t${rollup.parentJobId ?? "-"}\tchildren\t${rollup.childJobIds.length > 0 ? rollup.childJobIds.join(",") : "-"}`,
    "relation\tjobId\tstatus\tprofile\tdepth\tparentJobId\tchildren\tprompt\tfinalSummary",
  ];
  for (const record of records) {
    lines.push(
      [
        record.relations.join(","),
        record.jobId ?? "-",
        record.status ?? "-",
        record.profile ?? "-",
        record.delegationDepth ?? "-",
        record.parentJobId ?? "-",
        record.childJobIds.length > 0 ? record.childJobIds.join(",") : "-",
        briefText(record.prompt ?? ""),
        briefText(record.finalText ?? ""),
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}
