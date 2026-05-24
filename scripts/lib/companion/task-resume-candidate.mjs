import { stringFlag } from "../args.mjs";
import { resolveHostIdentity } from "../host-identity.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";
import { findResumeCandidate } from "./resume-candidate.mjs";

export async function run(subcommand, parsedArgs) {
  return runTaskResumeCandidate({ args: parsedArgs });
}

export async function runTaskResumeCandidate({ args, env = process.env, deps = {} }) {
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

function renderCandidate(record) {
  return {
    found: true,
    profile: record.profile,
    jobId: record.jobId,
    status: record.status,
    sessionId: record.sessionId,
    completedAt: record.completedAt,
  };
}
