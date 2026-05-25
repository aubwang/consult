import { spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stringFlag } from "../args.mjs";
import { resolveNewJobChain } from "../delegation-chain.mjs";
import {
  createQueuedJobRecord,
  writeJobRecord as defaultWriteJobRecord,
} from "../job-records.mjs";
import { defaultGenerateJobId } from "../job-ids.mjs";
import { runDelegateOnce } from "./delegate-core.mjs";
import { resolveInvocationContext } from "./invocation-context.mjs";
import { jobRecordErrorResult } from "./job-record-errors.mjs";
import { createOutput } from "./output.mjs";
import { profileErrorResult } from "./profile-errors.mjs";
import {
  findResumeCandidate,
  findResumeJobCandidate,
} from "./resume-candidate.mjs";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mjs";

const PROMPT_TRUNCATE_BYTES = 4096;
export async function run(subcommand, parsedArgs) {
  const result = await runDelegate({ args: parsedArgs });
  return { exitCode: result.exitCode, stdout: "", stderr: "" };
}

export async function runDelegate({ args, env = process.env, deps = {} }) {
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
  const { workspaceRoot, hostIdentity, selected } = context;
  if (selected.error) {
    output.stderr(`${selected.error}\n`);
    return output.result(2);
  }

  let resumeSessionId = null;
  if (validated.resumeJobId) {
    try {
      const resumeCandidate = await findResumeJobCandidate(
        workspaceRoot,
        validated.resumeJobId,
        selected.profile,
      );
      if (resumeCandidate.error) {
        output.stderr(`${resumeCandidate.error}\n`);
        return output.result(2);
      }
      resumeSessionId = resumeCandidate.record.sessionId;
    } catch (error) {
      if (error.code === "ENOENT") {
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
      const resumeCandidate = await findResumeCandidate(workspaceRoot, selected.profile, {
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
    prompt: validated.background ? validated.prompt : truncatePrompt(validated.prompt),
    model: validated.model,
    effort: validated.effort,
    resumeSessionId,
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
    profileEntry: selected.profileEntry,
    jobRecord,
    prompt: validated.prompt,
    model: validated.model,
    effort: validated.effort,
    resumeSessionId,
    deps,
    output,
    json: validated.json,
  });
}

function validateArgs(args) {
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

function truncatePrompt(prompt) {
  if (Buffer.byteLength(prompt) <= PROMPT_TRUNCATE_BYTES) {
    return prompt;
  }
  return `${truncateUtf8(prompt, PROMPT_TRUNCATE_BYTES)}...`;
}

function truncateUtf8(value, maxBytes) {
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

function companionCliPath() {
  return fileURLToPath(new URL("../../consult-companion.mjs", import.meta.url));
}
