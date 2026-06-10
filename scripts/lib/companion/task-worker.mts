import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { profilesPath } from "../broker-endpoint.mts";
import {
  readWorkspaceJobRecord,
  writeJobRecord as defaultWriteJobRecord,
  type JobRecord,
} from "../job-records.mts";
import { loadProfiles as defaultLoadProfiles } from "../profiles.mts";
import type { ProfilesData } from "../profiles.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { jobRecordErrorResult } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";
import { runDelegateOnce } from "./delegate-core.mts";
import type {
  EnsureBrokerSessionInput,
  EnsureBrokerSessionResult,
} from "../prompt-turn-runner.mts";
import { createOutput } from "./output.mts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TaskWorkerDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  readJobRecord?: (workspaceRoot: string, jobId: string) => Promise<JobRecord>;
  writeJobRecord?: (workspaceRoot: string, jobId: string, record: JobRecord) => Promise<void>;
  loadProfiles?: (path: string) => Promise<ProfilesData>;
  ensureBrokerSession?: (
    input: EnsureBrokerSessionInput,
  ) => Promise<EnsureBrokerSessionResult>;
  now?: () => string;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  [key: string]: unknown;
}

interface TaskWorkerOptions {
  args: ParsedArgs;
  deps?: TaskWorkerDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runTaskWorker({ args: parsedArgs });
}

export async function runTaskWorker({ args, deps = {} }: TaskWorkerOptions): Promise<CommandResult> {
  const output = createOutput(deps);
  const jobId = stringFlag(args.flags?.["job-id"]);
  if (!jobId) {
    output.stderr("task-worker requires --job-id\n");
    return output.result(2);
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  let jobRecord: JobRecord;
  try {
    jobRecord = await (deps.readJobRecord ?? readWorkspaceJobRecord)(workspaceRoot, jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  let profiles: ProfilesData;
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
  const profileEntry = profiles.profiles?.[jobRecord.profile as string];
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

function validateJobRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") {
    return "not an object";
  }
  for (const field of ["jobId", "prompt", "mode", "host", "hostSessionId", "profile"]) {
    if (typeof (record as Record<string, unknown>)[field] !== "string" || ((record as Record<string, unknown>)[field] as string).length === 0) {
      return `missing ${field}`;
    }
  }
  return null;
}
