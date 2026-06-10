import { spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { resolveNewJobChain } from "../delegation-chain.mts";
import {
  createQueuedJobRecord,
  writeJobRecord as defaultWriteJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import type { ProfileRecord } from "../profiles.mts";
import { defaultGenerateJobId } from "../job-ids.mts";
import { runDelegateOnce } from "./delegate-core.mts";
import type { RunDelegateOnceDeps } from "./delegate-core.mts";
import { resolveInvocationContext } from "./invocation-context.mts";
import type { ResolveInvocationContextDeps } from "./invocation-context.mts";
import { jobRecordErrorResult } from "./job-record-errors.mts";
import { createOutput } from "./output.mts";
import type { OutputDeps } from "./output.mts";
import { profileErrorResult } from "./profile-errors.mts";
import {
  findResumeCandidate,
  findResumeJobCandidate,
} from "./resume-candidate.mts";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mts";

export interface DelegateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DelegateDeps
  extends OutputDeps,
    ResolveInvocationContextDeps,
    RunDelegateOnceDeps {
  now?: () => string;
  generateJobId?: () => string;
  writeJobRecord?: typeof defaultWriteJobRecord;
  spawn?: typeof defaultSpawn;
  [key: string]: unknown;
}

export interface RunDelegateOptions {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: DelegateDeps;
}

export interface ValidatedDelegateArgs {
  error?: string;
  mode?: string;
  writeExplicit?: boolean;
  parentJobId?: string | null;
  prompt?: string;
  model?: string;
  effort?: string;
  json?: boolean;
  resume?: boolean;
  resumeJobId?: string;
  background?: boolean;
}

const PROMPT_TRUNCATE_BYTES = 4096;
export async function run(
  subcommand: string,
  parsedArgs: ParsedArgs,
): Promise<DelegateResult> {
  const result = await runDelegate({ args: parsedArgs });
  return { exitCode: result.exitCode, stdout: "", stderr: "" };
}

export async function runDelegate({
  args,
  env = process.env,
  deps = {},
}: RunDelegateOptions): Promise<DelegateResult> {
  const output = createOutput(deps);
  const validated = validateArgs(args);
  if (validated.error) {
    output.stderr(`${validated.error}\n`);
    return output.result(2);
  }

  let context;
  try {
    context = await resolveInvocationContext({
      args,
      env,
      deps,
    });
  } catch (error) {
    const profileResult = profileErrorResult(error);
    if (profileResult) {
      output.stderr(profileResult.stderr);
      return output.result(profileResult.exitCode);
    }
    const overrideResult = workspaceOverrideErrorResult(error);
    if (overrideResult) {
      output.stderr(overrideResult.stderr);
      return output.result(overrideResult.exitCode);
    }
    throw error;
  }
  const { workspaceRoot, hostIdentity, selected } = context as {
    workspaceRoot: string;
    hostIdentity: { host: string; hostSessionId: string };
    selected: { error?: string; profile?: string; profileEntry?: unknown };
  };
  if (selected.error) {
    output.stderr(`${selected.error}\n`);
    return output.result(2);
  }

  let resumeSessionId: string | null | undefined = null;
  if (validated.resumeJobId) {
    try {
      const resumeCandidate = await findResumeJobCandidate(
        workspaceRoot,
        validated.resumeJobId,
        selected.profile as string,
      );
      if (resumeCandidate.error) {
        output.stderr(`${resumeCandidate.error}\n`);
        return output.result(2);
      }
      resumeSessionId = (resumeCandidate as { record: JobRecord }).record.sessionId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        output.stderr(`resume job not found: ${validated.resumeJobId}\n`);
        return output.result(2);
      }
      const malformedResult = jobRecordErrorResult(error);
      if (malformedResult) {
        output.stderr(malformedResult.stderr);
        return output.result(malformedResult.exitCode);
      }
      throw error;
    }
  } else if (validated.resume) {
    try {
      const resumeCandidate = await findResumeCandidate(workspaceRoot, selected.profile as string, {
        host: hostIdentity.host,
        hostSessionId: hostIdentity.hostSessionId,
      });
      resumeSessionId = resumeCandidate?.sessionId ?? null;
    } catch (error) {
      const malformedResult = jobRecordErrorResult(error);
      if (malformedResult) {
        output.stderr(malformedResult.stderr);
        return output.result(malformedResult.exitCode);
      }
      throw error;
    }
    if (!resumeSessionId) {
      output.stderr(
        `No finalized delegate job found for profile '${selected.profile}' in this workspace; rerun with --fresh to start a new session\n`,
      );
      return output.result(2);
    }
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const generateJobId = deps.generateJobId ?? defaultGenerateJobId;
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const jobId = generateJobId();
  let chain;
  try {
    chain = await resolveNewJobChain({
      workspaceRoot,
      jobId,
      parentJobId: validated.parentJobId,
      requestedMode: validated.mode,
      writeExplicit: validated.writeExplicit,
    });
  } catch (error) {
    const malformedResult = jobRecordErrorResult(error);
    if (malformedResult) {
      output.stderr(malformedResult.stderr);
      return output.result(malformedResult.exitCode);
    }
    throw error;
  }
  if (chain.error) {
    output.stderr(`${chain.error}\n`);
    return output.result(2);
  }
  const submittedAt = now();
  const jobRecord = createQueuedJobRecord({
    jobId,
    kind: "delegate",
    submittedAt,
    ...chain.fields,
    mode: chain.mode,
    host: hostIdentity.host,
    hostSessionId: hostIdentity.hostSessionId,
    profile: selected.profile,
    prompt: validated.background ? validated.prompt : truncatePrompt(validated.prompt as string),
    model: validated.model,
    effort: validated.effort,
    resumeSessionId: resumeSessionId as string | undefined,
  });

  await writeJobRecord(workspaceRoot, jobId, jobRecord);

  if (validated.background) {
    const spawn = deps.spawn ?? defaultSpawn;
    const child = spawn(
      process.execPath,
      [companionCliPath(), "task-worker", "--job-id", jobId],
      {
        cwd: workspaceRoot,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...env },
      },
    );
    child.unref();
    output.stdout(`consult delegate ${jobId} queued\n/consult:status ${jobId}\n`);
    return output.result(0);
  }

  return runDelegateOnce({
    workspaceRoot,
    profileEntry: selected.profileEntry as Partial<ProfileRecord>,
    jobRecord,
    prompt: validated.prompt,
    model: validated.model,
    effort: validated.effort,
    resumeSessionId,
    deps,
    output,
    json: validated.json,
  }) as Promise<DelegateResult>;
}

function validateArgs(args: ParsedArgs): ValidatedDelegateArgs {
  const flags = args.flags ?? {};
  if (flags.write !== undefined && flags["read-only"] !== undefined) {
    return { error: "--write and --read-only are mutually exclusive" };
  }
  if (flags.resume !== undefined && flags.fresh !== undefined) {
    return { error: "--resume and --fresh are mutually exclusive" };
  }
  if (flags["resume-job"] !== undefined && flags.fresh !== undefined) {
    return { error: "--resume-job and --fresh are mutually exclusive" };
  }
  if (flags["resume-job"] !== undefined && flags.resume !== undefined) {
    return { error: "--resume-job and --resume are mutually exclusive" };
  }
  if (flags.background !== undefined && flags.wait !== undefined) {
    return { error: "--background and --wait are mutually exclusive" };
  }
  const promptFromFlag = stringFlag(flags.prompt);
  const promptFromPositionals = (args.positional ?? []).join(" ").trim();
  if (!promptFromFlag && !promptFromPositionals) {
    return { error: "delegate prompt is required" };
  }

  return {
    mode: flags.write !== undefined ? "write" : "read-only",
    writeExplicit: flags.write !== undefined,
    parentJobId:
      stringFlag(flags["parent-job"]) ?? stringFlag(flags["parent-job-id"]) ?? null,
    prompt: promptFromFlag || promptFromPositionals,
    model: stringFlag(flags.model),
    effort: stringFlag(flags.effort),
    json: flags.json !== undefined,
    resume: flags.resume !== undefined,
    resumeJobId: stringFlag(flags["resume-job"]),
    background: flags.background !== undefined,
  };
}

function truncatePrompt(prompt: string): string {
  if (Buffer.byteLength(prompt) <= PROMPT_TRUNCATE_BYTES) {
    return prompt;
  }
  return `${truncateUtf8(prompt, PROMPT_TRUNCATE_BYTES)}...`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      break;
    }
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function companionCliPath(): string {
  return fileURLToPath(new URL("../../consult-companion.mts", import.meta.url));
}
