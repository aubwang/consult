import { runCodexReview as defaultRunCodexReview } from "../../adapters/codex-review.mts";
import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import type { ProfileRecord } from "../profiles.mts";
import { resolveInvocationContext } from "./invocation-context.mts";
import { createOutput } from "./output.mts";
import { profileErrorResult } from "./profile-errors.mts";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mts";

const REVIEW_CODEX_ONLY =
  "/consult:review is codex-only in v1. Use /consult:delegate --agent <name> with a review-style prompt, or switch to --agent codex.";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ReviewDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  loadProfiles?: (path: string) => Promise<unknown>;
  loadOverride?: (workspaceRoot: string) => Promise<unknown>;
  runCodexReview?: (args: Record<string, unknown>) => Promise<CommandResult>;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  [key: string]: unknown;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  return runReview({ args: parsedArgs });
}

export async function runReview({
  args,
  env = process.env as Record<string, string | undefined>,
  deps = {},
}: {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: ReviewDeps;
}): Promise<CommandResult> {
  const output = createOutput(deps);
  let context: Awaited<ReturnType<typeof resolveInvocationContext>>;
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

  const profileEntry = selected.profileEntry as ProfileRecord;
  if (profileEntry.registryId !== "codex") {
    output.stderr(`${REVIEW_CODEX_ONLY}\n`);
    return output.result(6);
  }

  return (deps.runCodexReview ?? defaultRunCodexReview)({
    profile: selected.profile as string,
    profileEntry,
    workspaceRoot,
    host: hostIdentity.host,
    hostSessionId: hostIdentity.hostSessionId,
    baseRef: stringFlag(args.flags?.base) ?? null,
    kind: "review",
    deps,
  });
}
