import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { profilesPath } from "../broker-endpoint.mts";
import { cleanupIsolatedWorkspace as defaultCleanupIsolatedWorkspace } from "../isolated-workspace.mts";
import type { PreparedIsolatedWorkspace } from "../isolated-workspace.mts";
import {
  readWorkspaceJobRecord,
  writeJobRecord as defaultWriteJobRecord,
  type JobRecord,
} from "../job-records.mts";
import { loadProfiles as defaultLoadProfiles } from "../profiles.mts";
import type { ProfilesData } from "../profiles.mts";
import { processStartTime } from "../process-identity.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { jobLookupErrorResult } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";
import { runDelegateOnce } from "./delegate-core.mts";
import type { RunDelegateOnceDeps } from "./delegate-core.mts";
import type {
  EnsureBrokerSessionInput,
  EnsureBrokerSessionResult,
} from "../prompt-turn-runner.mts";
import { createOutput } from "./output.mts";
import type { CommandResult } from "./output.mts";

interface TaskWorkerDeps extends RunDelegateOnceDeps {
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
  cleanupIsolatedWorkspace?: (
    prepared: PreparedIsolatedWorkspace,
  ) => Promise<unknown>;
  [key: string]: unknown;
}

interface TaskWorkerOptions {
  args: ParsedArgs;
  deps?: TaskWorkerDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  const result = await runTaskWorker({ args: parsedArgs });
  return { exitCode: result.exitCode, stdout: "", stderr: "" };
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
    const lookupResult = jobLookupErrorResult(error, jobId, "job record not found");
    output.stderr(lookupResult.stderr);
    return output.result(lookupResult.exitCode);
  }

  const isolatedWorkspace = jobRecord.isolatedWorkspace;
  const invalidReason = validateJobRecord(jobRecord);
  if (invalidReason) {
    await cleanupPreparedWorkspace(isolatedWorkspace, deps);
    output.stderr(`invalid job record ${jobId}: ${invalidReason}\n`);
    return output.result(2);
  }

  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  Object.assign(jobRecord, {
    workerPid: process.pid,
    ...(jobRecord.isolated === true
      ? {
          runner: "inline",
          runnerPid: process.pid,
          runnerStartTime: (await processStartTime(process.pid).catch(() => null)) ?? undefined,
        }
      : {}),
  });
  try {
    await writeJobRecord(workspaceRoot, jobId, jobRecord);
  } catch (error) {
    await cleanupPreparedWorkspace(isolatedWorkspace, deps);
    throw error;
  }

  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let profiles: ProfilesData;
  try {
    profiles = await loadProfiles(profilesPath());
  } catch (error) {
    const profileResult = profileErrorResult(error);
    if (profileResult) {
      await cleanupPreparedWorkspace(isolatedWorkspace, deps);
      output.stderr(profileResult.stderr);
      return output.result(profileResult.exitCode);
    }
    await cleanupPreparedWorkspace(isolatedWorkspace, deps);
    throw error;
  }
  const profileEntry = profiles.profiles?.[jobRecord.profile as string];
  if (!profileEntry) {
    await cleanupPreparedWorkspace(isolatedWorkspace, deps);
    output.stderr(`invalid job record ${jobId}: unknown profile '${jobRecord.profile}'\n`);
    return output.result(2);
  }

  return runDelegateOnce({
    workspaceRoot,
    executionRoot: isolatedWorkspace?.executionRoot,
    profileEntry,
    jobRecord,
    model: jobRecord.model,
    effort: jobRecord.effort,
    resumeSessionId: jobRecord.resumeSessionId,
    deps,
    output,
    renderSummary: false,
    markFailedOnBrokerError: true,
    inline: jobRecord.isolated === true,
    allowExecute: jobRecord.allowExecute === true,
    isolatedWorkspace,
  });
}

async function cleanupPreparedWorkspace(
  prepared: PreparedIsolatedWorkspace | undefined,
  deps: TaskWorkerDeps,
): Promise<void> {
  if (!prepared) {
    return;
  }
  await (deps.cleanupIsolatedWorkspace ?? defaultCleanupIsolatedWorkspace)(prepared).catch(
    () => {},
  );
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
  if (
    (record as JobRecord).isolated === true &&
    (!(record as JobRecord).isolatedWorkspace ||
      typeof (record as JobRecord).isolatedWorkspace?.executionRoot !== "string")
  ) {
    return "missing isolatedWorkspace";
  }
  return null;
}
