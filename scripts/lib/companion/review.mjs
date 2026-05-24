import { runCodexReview as defaultRunCodexReview } from "../../adapters/codex-review.mjs";
import { stringFlag } from "../args.mjs";
import { resolveInvocationContext } from "./invocation-context.mjs";
import { createOutput } from "./output.mjs";
import { profileErrorResult } from "./profile-errors.mjs";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mjs";

const REVIEW_CODEX_ONLY =
  "/consult:review is codex-only in v1. Use /consult:delegate --agent <name> with a review-style prompt, or switch to --agent codex.";

export async function run(subcommand, parsedArgs) {
  return runReview({ args: parsedArgs });
}

export async function runReview({ args, env = process.env, deps = {} }) {
  const output = createOutput(deps);
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

  if (selected.profileEntry.registryId !== "codex") {
    output.stderr(`${REVIEW_CODEX_ONLY}\n`);
    return output.result(6);
  }

  return (deps.runCodexReview ?? defaultRunCodexReview)({
    profile: selected.profile,
    profileEntry: selected.profileEntry,
    workspaceRoot,
    host: hostIdentity.host,
    hostSessionId: hostIdentity.hostSessionId,
    baseRef: stringFlag(args.flags?.base) ?? null,
    kind: "review",
    deps,
  });
}
