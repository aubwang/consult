import path from "node:path";

export const SANDBOX_HOME = "/tmp";

const PROFILE_LAUNCH_POLICIES = {
  claude: {
    homeReadOnlyDirs: [".claude"],
  },
  codex: {
    homeReadOnlyFiles: [".codex/auth.json", ".codex/config.toml", ".codex/AGENTS.md"],
  },
  gemini: {
    homeReadOnlyFiles: [
      ".gemini/settings.json",
      ".gemini/oauth_creds.json",
      ".gemini/GEMINI.md",
      ".gemini/mcp-oauth-tokens.json",
      ".gemini/a2a-oauth-tokens.json",
    ],
    runtimeReadOnlyFiles: (env) => {
      const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
      if (typeof credentialsPath !== "string" || credentialsPath === "") {
        return [];
      }
      const resolvedPath = path.resolve(credentialsPath);
      return [{ source: resolvedPath, destination: resolvedPath }];
    },
  },
};

export function profileLaunchPolicy(registryId) {
  return PROFILE_LAUNCH_POLICIES[registryId] ?? null;
}

export function profileHomeMounts(registryId, env = {}) {
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

export function profileRuntimeMounts(registryId, env = {}) {
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

function homeMounts(home, relativePaths) {
  return relativePaths.map((relativePath) => ({
    source: path.join(home, relativePath),
    destination: path.join(SANDBOX_HOME, relativePath),
  }));
}
