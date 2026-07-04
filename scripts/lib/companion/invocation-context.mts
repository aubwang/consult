import fs from "node:fs/promises";

import { stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { overrideFilePath, profilesPath } from "../broker-endpoint.mts";
import type { HostIdentity } from "../host-identity.mts";
import { resolveHostIdentity } from "../host-identity.mts";
import { loadProfiles as defaultLoadProfiles } from "../profiles.mts";
import type { ProfileRecord, ProfilesData } from "../profiles.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import type { CliResult } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mts";

export interface WorkspaceOverride {
  profile?: string;
}

export interface WorkspaceOverrideError extends Error {
  code: string;
  path: string;
}

export interface SelectProfileSuccess {
  profile: string;
  profileEntry: ProfileRecord;
  error?: undefined;
}

export interface SelectProfileError {
  error: string;
  profile?: undefined;
  profileEntry?: undefined;
}

export type SelectProfileResult = SelectProfileSuccess | SelectProfileError;

export interface SelectProfileOptions {
  args: { flags?: Record<string, unknown> };
  profiles: Pick<ProfilesData, "default" | "hostDefaults" | "profiles">;
  override: WorkspaceOverride | null;
  host: string;
}

export interface InvocationContext {
  workspaceRoot: string;
  hostIdentity: HostIdentity;
  profiles: ProfilesData;
  override: WorkspaceOverride | null;
  selected: SelectProfileResult;
}

export interface ResolveInvocationContextDeps {
  resolveWorkspaceRoot?: () => Promise<string>;
  loadProfiles?: (path: string) => Promise<ProfilesData>;
  loadOverride?: (workspaceRoot: string) => Promise<WorkspaceOverride | null>;
}

export interface ResolveInvocationContextOptions {
  args: ParsedArgs;
  env?: NodeJS.ProcessEnv;
  deps?: ResolveInvocationContextDeps;
}

export async function resolveInvocationContext({
  args,
  env = process.env,
  deps = {},
}: ResolveInvocationContextOptions): Promise<InvocationContext> {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const hostIdentity = resolveHostIdentity({ args, env });
  const profiles = await (deps.loadProfiles ?? defaultLoadProfiles)(profilesPath());
  const override = await (deps.loadOverride ?? loadWorkspaceOverride)(workspaceRoot);
  const selected = selectProfile({ args, profiles, override, host: hostIdentity.host });
  return {
    workspaceRoot,
    hostIdentity,
    profiles,
    override,
    selected,
  };
}

export interface InvocationContextResult {
  context?: InvocationContext;
  errorResult?: CliResult;
}

export async function tryResolveInvocationContext(
  options: ResolveInvocationContextOptions,
): Promise<InvocationContextResult> {
  try {
    return { context: await resolveInvocationContext(options) };
  } catch (error) {
    const profileResult = profileErrorResult(error);
    if (profileResult) {
      return { errorResult: profileResult };
    }
    const overrideResult = workspaceOverrideErrorResult(error);
    if (overrideResult) {
      return { errorResult: overrideResult };
    }
    throw error;
  }
}

export function selectProfile({
  args,
  profiles,
  override,
  host,
}: SelectProfileOptions): SelectProfileResult {
  const available = Object.keys(profiles.profiles ?? {});
  const explicit = stringFlag(args.flags?.agent) ?? stringFlag(args.flags?.profile);
  const profile = explicit ?? override?.profile ?? profiles.hostDefaults?.[host] ?? profiles.default;
  if (!profile) {
    return {
      error:
        available.length === 0
          ? "No profile configured (no profiles configured; run 'consult setup')"
          : `No profile selected. Available profiles: ${available.join(", ")}`,
    };
  }
  const profileEntry = profiles.profiles?.[profile];
  if (!profileEntry) {
    const availableText = available.length > 0 ? available.join(", ") : "(none)";
    return { error: `Unknown profile '${profile}'. Available profiles: ${availableText}` };
  }
  return { profile, profileEntry };
}

export async function loadWorkspaceOverride(
  workspaceRoot: string,
): Promise<WorkspaceOverride | null> {
  const path = overrideFilePath(workspaceRoot);
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as WorkspaceOverride;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      const malformed = new Error("Workspace override file is malformed") as WorkspaceOverrideError;
      malformed.code = "WORKSPACE_OVERRIDE_MALFORMED";
      malformed.path = path;
      throw malformed;
    }
    throw error;
  }
}
