import fs from "node:fs/promises";

import { addJobRelationships } from "../delegation-chain.mjs";
import {
  isFinalStatus,
  jobLogPath,
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "../job-records.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";

export async function run(subcommand, parsedArgs) {
  return runStatus({ args: parsedArgs });
}

export async function runStatus({ args, deps = {} }) {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const jobId = args.positional?.[0];
  if (jobId) {
    let record;
    try {
      record = args.flags?.wait
        ? await waitForFinalRecord(workspaceRoot, jobId, deps)
        : await readWorkspaceJobRecord(workspaceRoot, jobId);
    } catch (error) {
      if (error.code === "ENOENT") {
        return { exitCode: 2, stdout: "", stderr: `job not found: ${jobId}\n` };
      }
      if (error.code === "WAIT_TIMEOUT") {
        return { exitCode: 4, stdout: "", stderr: `${error.message}\n` };
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
  const enrichedRecords = records.map((record) => addJobRelationships(record, records));
  return {
    exitCode: 0,
    stdout: args.flags?.json
      ? `${JSON.stringify(enrichedRecords)}\n`
      : renderJobTable(enrichedRecords),
    stderr: "",
  };
}

async function waitForFinalRecord(workspaceRoot, jobId, deps) {
  const deadline = Date.now() + (deps.maxWaitMs ?? 30 * 60 * 1000);
  const poll = deps.poll ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  while (!isFinalStatus(record.status)) {
    if (Date.now() >= deadline) {
      const error = new Error(`timed out waiting for job ${jobId}`);
      error.code = "WAIT_TIMEOUT";
      throw error;
    }
    await poll(200);
    record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  }
  return record;
}

async function readLogTail(workspaceRoot, jobId) {
  let contents;
  try {
    contents = await fs.readFile(jobLogPath(workspaceRoot, jobId), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return contents.trimEnd().split("\n").slice(-20);
}

function renderJobTable(records) {
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
          briefPrompt(record.prompt ?? ""),
        ].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function briefPrompt(prompt) {
  const compact = String(prompt).replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}
