import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { resolveHostIdentity } from "../host-identity.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import type { JobRecord } from "../job-records.mts";
import { jobRecordErrorResult } from "./job-record-errors.mts";
import type { CommandResult } from "./output.mts";
import { findResumeCandidate } from "./resume-candidate.mts";

interface TaskResumeCandidateDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  listJobRecords?: (workspaceRoot: string) => Promise<JobRecord[]>;
}

interface TaskResumeCandidateOptions {
  args: ParsedArgs;
  env?: NodeJS.ProcessEnv;
  deps?: TaskResumeCandidateDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runTaskResumeCandidate({ args: parsedArgs });
}

export async function runTaskResumeCandidate({
  args,
  env = process.env,
  deps = {},
}: TaskResumeCandidateOptions): Promise<CommandResult> {
  const profile = stringFlag(args.flags?.profile) ?? stringFlag(args.flags?.agent);
  if (!profile) {
    return { exitCode: 2, stdout: "", stderr: "profile is required\n" };
  }

  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const hostIdentity = resolveHostIdentity({ args, env });
  let candidate;
  try {
    candidate = await findResumeCandidate(workspaceRoot, profile, {
      ...deps,
      host: hostIdentity.host,
      hostSessionId: hostIdentity.hostSessionId,
    });
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
      candidate ? renderCandidate(candidate) : { found: false, profile },
    )}\n`,
    stderr: "",
  };
}

function renderCandidate(record: JobRecord) {
  return {
    found: true,
    profile: record.profile,
    jobId: record.jobId,
    status: record.status,
    sessionId: record.sessionId,
    completedAt: record.completedAt,
  };
}
