import { spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  boolFlag,
  missingFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { resolveNewJobChain } from "../delegation-chain.mts";
import {
  appendPinnedDiff,
  getDiff as defaultGetDiff,
  pinnedDiffErrorMessage,
} from "../git.mts";
import type { GetDiffOptions } from "../git.mts";
import {
  createQueuedJobRecord,
  failJobRecord,
  jobLogPath,
  writeJobRecord as defaultWriteJobRecord,
} from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { resolveJobAuthority } from "../job-authority.mts";
import type { JobAuthority, JobAuthorityDiagnostic } from "../job-authority.mts";
import {
  preflightJobAuthority as defaultPreflightJobAuthority,
  probeInheritedProfileLaunch,
} from "../job-authority-preflight.mts";
import type {
  JobAuthorityPreflightInput,
  JobAuthorityPreflightResult,
} from "../job-authority-preflight.mts";
import { probeConfinedSandboxRuntime } from "../sandbox-runtime-launch.mts";
import {
  validateConfinedSessionStateArchive as defaultValidateConfinedSessionStateArchive,
} from "../confined-session-state.mts";
import { jobResultEnvelope } from "../job-result-contract.mts";
import { defaultGenerateJobId } from "../job-ids.mts";
import {
  cleanupIsolatedWorkspace as defaultCleanupIsolatedWorkspace,
  prepareIsolatedWorkspace as defaultPrepareIsolatedWorkspace,
} from "../isolated-workspace.mts";
import type { PreparedIsolatedWorkspace } from "../isolated-workspace.mts";
import { processStartTime } from "../process-identity.mts";
import { runDelegateOnce } from "./delegate-core.mts";
import type { RunDelegateOnceDeps } from "./delegate-core.mts";
import { tryResolveInvocationContext } from "./invocation-context.mts";
import type { InvocationContext, ResolveInvocationContextDeps } from "./invocation-context.mts";
import { jobLookupErrorResult, jobRecordErrorResult } from "./job-record-errors.mts";
import type { CliResult } from "./job-record-errors.mts";
import { createOutput } from "./output.mts";
import type { OutputDeps } from "./output.mts";
import { writeAuthorityDiagnostic } from "./authority-diagnostic.mts";
import {
  findResumeCandidate,
  findResumeJobCandidate,
} from "./resume-candidate.mts";

export type DelegateResult = CliResult;

export interface DelegateDeps
  extends OutputDeps,
    ResolveInvocationContextDeps,
    RunDelegateOnceDeps {
  now?: () => string;
  generateJobId?: () => string;
  writeJobRecord?: typeof defaultWriteJobRecord;
  getDiff?: (options: GetDiffOptions) => Promise<string>;
  spawn?: typeof defaultSpawn;
  prepareIsolatedWorkspace?: typeof defaultPrepareIsolatedWorkspace;
  cleanupIsolatedWorkspace?: typeof defaultCleanupIsolatedWorkspace;
  preflightAuthority?: (
    input: JobAuthorityPreflightInput,
  ) => Promise<JobAuthorityPreflightResult>;
  validateSessionStateArchive?: typeof defaultValidateConfinedSessionStateArchive;
  [key: string]: unknown;
}

export interface RunDelegateOptions {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: DelegateDeps;
}

export interface ValidatedDelegateArgs {
  error?: string;
  diagnostic?: JobAuthorityDiagnostic;
  authority?: JobAuthority;
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
  includeDiff?: boolean;
  baseRef?: string;
  isolated?: boolean;
  allowFetch?: boolean;
  allowExecute?: boolean;
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
  if (validated.diagnostic) {
    writeAuthorityDiagnostic(output, validated.diagnostic, boolFlag(args.flags?.json));
    return output.result(2);
  }
  if (validated.error) {
    output.stderr(`${validated.error}\n`);
    return output.result(2);
  }

  const { context, errorResult } = await tryResolveInvocationContext({
    args,
    env,
    deps,
  });
  if (errorResult) {
    output.stderr(errorResult.stderr);
    return output.result(errorResult.exitCode);
  }
  const { workspaceRoot, hostIdentity, selected } = context as InvocationContext;
  if (selected.error) {
    output.stderr(`${selected.error}\n`);
    return output.result(2);
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const generateJobId = deps.generateJobId ?? defaultGenerateJobId;
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const jobId = generateJobId();
  // Delegation lineage: an explicit --parent-job flag wins; otherwise fall
  // back to CONSULT_PARENT_JOB, which the Broker injects into delegated agent
  // environments so nested delegations stay chained (ADR-0007/0008).
  const parentJobId = validated.parentJobId ?? (env.CONSULT_PARENT_JOB || null);
  let chain;
  try {
    chain = await resolveNewJobChain({
      workspaceRoot,
      jobId,
      parentJobId,
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
  const authority: JobAuthority = {
    ...(validated.authority as JobAuthority),
    mode: chain.mode as JobAuthority["mode"],
  };
  const preflight = await (
    deps.preflightAuthority ??
    ((input: JobAuthorityPreflightInput) =>
      defaultPreflightJobAuthority(input, {
        probeConfined: probeConfinedSandboxRuntime,
        probeInherited: probeInheritedProfileLaunch,
      }))
  )({
    authority,
    parentJob: chain.parent,
    workspaceRoot,
    profile: selected.profile as string,
    profileRegistryId: selected.profileEntry?.registryId,
    profileLaunch: selected.profileEntry
      ? {
          binary: selected.profileEntry.binary,
          args: selected.profileEntry.args,
          env: selected.profileEntry.env,
        }
      : undefined,
  });
  if (!preflight.ok) {
    writeAuthorityDiagnostic(output, preflight.diagnostic, validated.json === true);
    return output.result(2);
  }

  let resumeSessionId: string | null | undefined = null;
  let resumeSourceJobId: string | null | undefined = null;
  if (validated.resumeJobId) {
    try {
      const resumeCandidate = await findResumeJobCandidate(
        workspaceRoot,
        validated.resumeJobId,
        selected.profile!,
      );
      if (resumeCandidate.error) {
        output.stderr(`${resumeCandidate.error}\n`);
        return output.result(2);
      }
      resumeSessionId = resumeCandidate.record!.sessionId;
      resumeSourceJobId = resumeCandidate.record!.jobId;
    } catch (error) {
      const lookupResult = jobLookupErrorResult(
        error,
        validated.resumeJobId,
        "resume job not found",
      );
      output.stderr(lookupResult.stderr);
      return output.result(lookupResult.exitCode);
    }
  } else if (validated.resume) {
    try {
      const resumeCandidate = await findResumeCandidate(workspaceRoot, selected.profile!, {
        host: hostIdentity.host,
        hostSessionId: hostIdentity.hostSessionId,
      });
      resumeSessionId = resumeCandidate?.sessionId ?? null;
      resumeSourceJobId = resumeCandidate?.jobId ?? null;
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

  if (
    authority.confinement === "confined" &&
    resumeSourceJobId &&
    resumeSessionId
  ) {
    if (validated.isolated) {
      output.stderr(
        "confined resume is unavailable with --isolated because the Execution Workspace cwd changes; use a non-isolated Job or --fresh\n",
      );
      return output.result(2);
    }
    try {
      await (
        deps.validateSessionStateArchive ?? defaultValidateConfinedSessionStateArchive
      )({
        workspaceRoot,
        jobId: resumeSourceJobId,
        profileRegistryId:
          selected.profileEntry?.registryId ?? (selected.profile as string),
        sessionId: resumeSessionId,
        cwd: workspaceRoot,
      });
    } catch (error) {
      output.stderr(
        `RESUME_STATE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}; rerun with --fresh\n`,
      );
      return output.result(2);
    }
  }

  let delegatedPrompt = validated.prompt as string;
  if (validated.includeDiff) {
    try {
      const getDiff = deps.getDiff ?? defaultGetDiff;
      const diff = await getDiff(
        validated.baseRef
          ? { baseRef: validated.baseRef, cwd: workspaceRoot }
          : { cwd: workspaceRoot },
      );
      delegatedPrompt = appendPinnedDiff(delegatedPrompt, diff, {
        baseRef: validated.baseRef ?? null,
      });
    } catch (error) {
      output.stderr(`${pinnedDiffErrorMessage(error)}\n`);
      return output.result(2);
    }
  }

  let isolatedWorkspace: PreparedIsolatedWorkspace | undefined;
  if (validated.isolated) {
    try {
      isolatedWorkspace = await (
        deps.prepareIsolatedWorkspace ?? defaultPrepareIsolatedWorkspace
      )({ workspaceRoot, jobId });
    } catch (error) {
      output.stderr(`isolated workspace preparation failed: ${(error as Error).message}\n`);
      return output.result(1);
    }
  }
  const submittedAt = now();
  const jobRecord = createQueuedJobRecord({
    jobId,
    kind: "delegate",
    submittedAt,
    ...chain.fields,
    authority,
    mode: authority.mode,
    host: hostIdentity.host,
    hostSessionId: hostIdentity.hostSessionId,
    profile: selected.profile,
    prompt: validated.background ? delegatedPrompt : truncatePrompt(validated.prompt as string),
    model: validated.model,
    effort: validated.effort,
    ...(validated.includeDiff
      ? { includeDiff: true, baseRef: validated.baseRef }
      : {}),
    isolated: validated.isolated,
    allowExecute: authority.allowExecute,
    isolatedWorkspace,
    cleanupMetadataPath: isolatedWorkspace?.cleanupMetadataPath,
    resumeSessionId: resumeSessionId as string | undefined,
    resumeJobId: resumeSourceJobId as string | undefined,
    // Foreground jobs run in-process (ADR-0021); record the runner kind,
    // companion pid, and pid start time so `consult cancel` can signal it
    // (without pid-reuse risk) instead of dialing a Broker endpoint.
    ...(validated.background
      ? {}
      : {
          runner: "inline",
          runnerPid: process.pid,
          runnerStartTime: (await processStartTime(process.pid).catch(() => null)) ?? undefined,
        }),
  });

  try {
    await writeJobRecord(workspaceRoot, jobId, jobRecord);
  } catch (error) {
    if (isolatedWorkspace) {
      await (deps.cleanupIsolatedWorkspace ?? defaultCleanupIsolatedWorkspace)(
        isolatedWorkspace,
      ).catch(() => {});
    }
    throw error;
  }

  if (validated.background) {
    const spawn = deps.spawn ?? defaultSpawn;
    let child;
    try {
      child = spawn(
        process.execPath,
        [companionCliPath(), "task-worker", "--job-id", jobId],
        {
          cwd: workspaceRoot,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, ...env },
        },
      );
    } catch (error) {
      if (isolatedWorkspace) {
        await (deps.cleanupIsolatedWorkspace ?? defaultCleanupIsolatedWorkspace)(
          isolatedWorkspace,
        ).catch(() => {});
      }
      const message = `task worker spawn failed: ${(error as Error).message}`;
      failJobRecord(jobRecord, { now, errorMessage: message });
      await writeJobRecord(workspaceRoot, jobId, jobRecord);
      output.stderr(`${message}\n`);
      return output.result(1);
    }
    child.unref();
    if (validated.json) {
      output.stdout(
        `${JSON.stringify(
          jobResultEnvelope(jobRecord, {
            logPath: jobLogPath(workspaceRoot, jobId),
          }),
        )}\n`,
      );
    } else {
      output.stdout(`consult delegate ${jobId} queued\nconsult status ${jobId}\n`);
    }
    return output.result(0);
  }

  return runDelegateOnce({
    workspaceRoot,
    executionRoot: isolatedWorkspace?.executionRoot,
    profileEntry: selected.profileEntry!,
    jobRecord,
    prompt: delegatedPrompt,
    model: validated.model,
    effort: validated.effort,
    resumeSessionId,
    resumeJobId: resumeSourceJobId,
    deps,
    output,
    json: validated.json,
    inline: true,
    markFailedOnBrokerError: true,
    isolatedWorkspace,
  });
}

function validateArgs(args: ParsedArgs): ValidatedDelegateArgs {
  const flags = args.flags ?? {};
  const unsupported = unsupportedFlagError(flags, [
    "agent", "profile", "model", "effort", "host", "host-session",
    "host-session-id", "parent-job", "parent-job-id", "resume-job", "prompt",
    "base", "sandbox", "write", "read-only", "resume", "fresh", "background",
    "wait", "include-diff", "isolated", "allow-fetch", "allow-exec", "json",
  ]);
  if (unsupported) return { error: unsupported };
  const missingValue = missingFlagValueError(flags, [
    "agent",
    "profile",
    "model",
    "effort",
    "host",
    "host-session",
    "host-session-id",
    "parent-job",
    "parent-job-id",
    "resume-job",
    "prompt",
    "base",
    "sandbox",
  ]);
  if (missingValue) {
    return { error: missingValue };
  }
  const write = boolFlag(flags.write);
  const readOnly = boolFlag(flags["read-only"]);
  const resume = boolFlag(flags.resume);
  const fresh = boolFlag(flags.fresh);
  const background = boolFlag(flags.background);
  const wait = boolFlag(flags.wait);
  const resumeJobId = stringFlag(flags["resume-job"]);
  const includeDiff = boolFlag(flags["include-diff"]);
  const baseRef = stringFlag(flags.base);
  const isolated = boolFlag(flags.isolated);
  const allowFetch = boolFlag(flags["allow-fetch"]);
  const allowExecute = boolFlag(flags["allow-exec"]);
  if (write && readOnly) {
    return { error: "--write and --read-only are mutually exclusive" };
  }
  if (resume && fresh) {
    return { error: "--resume and --fresh are mutually exclusive" };
  }
  if (resumeJobId !== undefined && fresh) {
    return { error: "--resume-job and --fresh are mutually exclusive" };
  }
  if (resumeJobId !== undefined && resume) {
    return { error: "--resume-job and --resume are mutually exclusive" };
  }
  if (background && wait) {
    return { error: "--background and --wait are mutually exclusive" };
  }
  if (baseRef !== undefined && !includeDiff) {
    return { error: "--base requires --include-diff" };
  }
  if (isolated && !write) {
    return { error: "--isolated requires --write" };
  }
  const authority = resolveJobAuthority({
    mode: write ? "write" : "read-only",
    confinement: stringFlag(flags.sandbox),
    allowFetch,
    allowExecute,
    isolated,
  });
  if (!authority.ok) {
    return { diagnostic: authority.diagnostic };
  }
  const promptFromFlag = stringFlag(flags.prompt);
  const promptFromPositionals = (args.positional ?? []).join(" ").trim();
  if (!promptFromFlag && !promptFromPositionals) {
    return { error: "delegate prompt is required" };
  }

  return {
    authority: authority.authority,
    mode: authority.authority.mode,
    writeExplicit: write,
    parentJobId:
      stringFlag(flags["parent-job"]) ?? stringFlag(flags["parent-job-id"]) ?? null,
    prompt: promptFromFlag || promptFromPositionals,
    model: stringFlag(flags.model),
    effort: stringFlag(flags.effort),
    json: boolFlag(flags.json),
    resume,
    resumeJobId,
    background,
    includeDiff,
    baseRef,
    isolated,
    allowFetch,
    allowExecute,
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

export function companionCliPath(moduleUrl: string = import.meta.url): string {
  const extension = moduleUrl.endsWith(".mts") ? ".mts" : ".mjs";
  return fileURLToPath(new URL(`../../consult-companion${extension}`, moduleUrl));
}
