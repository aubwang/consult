import path from "node:path";

export const SANDBOX_HOME = "/tmp";

export interface ProfileMount {
  source: string;
  destination: string;
}

export interface ProfileLaunchPolicy {
  homeReadOnlyDirs?: string[];
  homeReadOnlyFiles?: string[];
  readOnlyPaths?: string[];
  runtimeReadOnlyFiles?: (env: NodeJS.ProcessEnv) => ProfileMount[];
}

const PROFILE_LAUNCH_POLICIES: Record<string, ProfileLaunchPolicy | undefined> = {
  claude: {
    homeReadOnlyDirs: [".claude"],
  },
  codex: {
    homeReadOnlyFiles: [".codex/auth.json", ".codex/config.toml", ".codex/AGENTS.md"],
  },
};

export function profileLaunchPolicy(registryId: string | undefined): ProfileLaunchPolicy | null {
  return PROFILE_LAUNCH_POLICIES[registryId as string] ?? null;
}

export function profileHomeMounts(
  registryId: string | undefined,
  env: NodeJS.ProcessEnv = {},
): ProfileMount[] {
  const policy = profileLaunchPolicy(registryId);
  const home = env.HOME ?? process.env.HOME;
  if (!policy || !home) {
    return [];
  }

  return [
    ...homeMounts(home, policy.homeReadOnlyDirs ?? []),
    ...homeMounts(home, policy.homeReadOnlyFiles ?? []),
  ];
}

export function profileRuntimeMounts(
  registryId: string | undefined,
  env: NodeJS.ProcessEnv = {},
): ProfileMount[] {
  const policy = profileLaunchPolicy(registryId);
  if (!policy) {
    return [];
  }

  return [
    ...(policy.readOnlyPaths ?? []).map((sourcePath) => ({
      source: sourcePath,
      destination: sourcePath,
    })),
    ...(policy.runtimeReadOnlyFiles?.(env) ?? []),
  ];
}

function homeMounts(home: string, relativePaths: string[]): ProfileMount[] {
  return relativePaths.map((relativePath) => ({
    source: path.join(home, relativePath),
    destination: path.join(SANDBOX_HOME, relativePath),
  }));
}
