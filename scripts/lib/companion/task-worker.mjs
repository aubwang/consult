import { stringFlag } from "../args.mjs";
import { profilesPath } from "../broker-endpoint.mjs";
import {
  readWorkspaceJobRecord,
  writeJobRecord as defaultWriteJobRecord,
} from "../job-records.mjs";
import { loadProfiles as defaultLoadProfiles } from "../profiles.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";
import { profileErrorResult } from "./profile-errors.mjs";
import { runDelegateOnce } from "./delegate-core.mjs";
import { createOutput } from "./output.mjs";

export async function run(subcommand, parsedArgs) {
  return runTaskWorker({ args: parsedArgs });
}

export async function runTaskWorker({ args, deps = {} }) {
  const output = createOutput(deps);
  const jobId = stringFlag(args.flags?.["job-id"]);
  if (!jobId) {
    output.stderr("task-worker requires --job-id\n");
    return output.result(2);
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  let jobRecord;
  try {
    jobRecord = await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
  } catch (error) {
    if (error.code === "ENOENT") {
      output.stderr(`job record not found: ${jobId}\n`);
      return output.result(2);
    }
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      output.stderr(malformedResult.stderr);
      return output.result(malformedResult.exitCode);
    }
    throw error;
  }

  const invalidReason = validateJobRecord(jobRecord);
  if (invalidReason) {
    output.stderr(`invalid job record ${jobId}: ${invalidReason}\n`);
    return output.result(2);
  }

  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  Object.assign(jobRecord, { workerPid: process.pid });
  await writeJobRecord(workspaceRoot, jobId, jobRecord);

  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let profiles;
  try {
    profiles = await loadProfiles(profilesPath());
  } catch (error) {
    const profileResult = profileErrorResult(error);
    if (profileResult) {
      output.stderr(profileResult.stderr);
      return output.result(profileResult.exitCode);
    }
    throw error;
  }
  const profileEntry = profiles.profiles?.[jobRecord.profile];
  if (!profileEntry) {
    output.stderr(`invalid job record ${jobId}: unknown profile '${jobRecord.profile}'\n`);
    return output.result(2);
  }

  return runDelegateOnce({
    workspaceRoot,
    profileEntry,
    jobRecord,
    model: jobRecord.model,
    effort: jobRecord.effort,
    resumeSessionId: jobRecord.resumeSessionId,
    deps,
    output,
    renderSummary: false,
    markFailedOnBrokerError: true,
  });
}

function validateJobRecord(record) {
  if (!record || typeof record !== "object") {
    return "not an object";
  }
  for (const field of ["jobId", "prompt", "mode", "host", "hostSessionId", "profile"]) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      return `missing ${field}`;
    }
  }
  return null;
}
