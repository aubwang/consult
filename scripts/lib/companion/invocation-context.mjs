import fs from "node:fs/promises";

import { stringFlag } from "../args.mjs";
import { overrideFilePath, profilesPath } from "../broker-endpoint.mjs";
import { resolveHostIdentity } from "../host-identity.mjs";
import { loadProfiles as defaultLoadProfiles } from "../profiles.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";

export async function resolveInvocationContext({ args, env = process.env, deps = {} }) {
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

export function selectProfile({ args, profiles, override, host }) {
  const available = Object.keys(profiles.profiles ?? {});
  const explicit = stringFlag(args.flags?.agent) ?? stringFlag(args.flags?.profile);
  const profile = explicit ?? override?.profile ?? profiles.hostDefaults?.[host] ?? profiles.default;
  if (!profile) {
    return {
      error:
        available.length === 0
          ? "No profile configured (no profiles configured; run /consult:setup)"
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

export async function loadWorkspaceOverride(workspaceRoot) {
  const path = overrideFilePath(workspaceRoot);
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      const malformed = new Error("Workspace override file is malformed");
      malformed.code = "WORKSPACE_OVERRIDE_MALFORMED";
      malformed.path = path;
      throw malformed;
    }
    throw error;
  }
}
