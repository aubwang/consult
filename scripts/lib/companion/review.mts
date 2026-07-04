import { runCodexReview as defaultRunCodexReview } from "../../adapters/codex-review.mts";
import { missingFlagValueError, stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import type { ProfileRecord, ProfilesData } from "../profiles.mts";
import { findRegistryEntry, loadRegistry as defaultLoadRegistry } from "../registry.mts";
import type { Registry } from "../registry.mts";
import { tryResolveInvocationContext } from "./invocation-context.mts";
import type { WorkspaceOverride } from "./invocation-context.mts";
import { createOutput } from "./output.mts";
import type { CommandResult } from "./output.mts";

const REVIEW_CODEX_ONLY =
  "/consult:review is codex-only in v1. Use /consult:delegate --agent <name> with a review-style prompt, or switch to --agent codex.";

export interface ReviewDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  loadProfiles?: (path: string) => Promise<ProfilesData>;
  loadOverride?: (workspaceRoot: string) => Promise<WorkspaceOverride | null>;
  loadRegistry?: () => Promise<Registry>;
  runCodexReview?: (args: Record<string, unknown>) => Promise<CommandResult>;
  stdoutWrite?: (text: string) => void;
  stderrWrite?: (text: string) => void;
  [key: string]: unknown;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CommandResult> {
  const result = await runReview({ args: parsedArgs });
  return { exitCode: result.exitCode, stdout: "", stderr: "" };
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
  const usageError = missingFlagValueError(args.flags, [
    "agent",
    "profile",
    "host",
    "host-session",
    "host-session-id",
    "base",
  ]);
  if (usageError) {
    output.stderr(`${usageError}\n`);
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
  const { workspaceRoot, hostIdentity, selected } = context!;
  if (selected.error) {
    output.stderr(`${selected.error}\n`);
    return output.result(2);
  }

  const profileEntry = selected.profileEntry as ProfileRecord;
  const registry = await (deps.loadRegistry ?? defaultLoadRegistry)();
  const registryEntry = findRegistryEntry(registry, profileEntry.registryId);
  if (!registryEntry?.advertisesReview) {
    output.stderr(`${REVIEW_CODEX_ONLY}\n`);
    return output.result(7);
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
