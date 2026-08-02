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

/**
 * Environment that pins a delegated Profile session's own sandbox preset to
 * the Job mode. codex-acp reads `INITIAL_AGENT_MODE` when it creates a
 * session; without it every Job runs Codex's default `agent` preset
 * (workspace-write). That preset's Linux bubblewrap sandbox must mount
 * read-only protections over `.git`/`.agents`/`.codex` beneath each writable
 * root, creating any missing mount point first — and a read-only Job mounts
 * the Workspace read-only, so that mkdir fails with EROFS and every
 * shell-mediated command dies before it runs. Pinning the preset to the Job
 * mode keeps the inner sandbox aligned with Job Authority instead of wider
 * than it.
 */
export function profileSessionModeEnv(
  registryId: string | undefined,
  mode: string | undefined,
): Record<string, string> {
  if (registryId !== "codex") {
    return {};
  }
  if (mode === "read-only") {
    return { INITIAL_AGENT_MODE: "read-only" };
  }
  if (mode === "write") {
    return { INITIAL_AGENT_MODE: "agent" };
  }
  return {};
}

/**
 * Environment that points codex-acp at the Codex CLI Consult pinned during
 * setup. codex-acp spawns `$CODEX_PATH app-server` when the variable is set and
 * otherwise resolves `@openai/codex/bin/codex.js` through the npm tree around
 * itself — a fallback that cannot work for the standalone compiled adapter
 * builds, or when Consult adopted a `codex-acp` that was installed without its
 * bundled Codex. Setup records the reachable binary once (ADR-0036) and every
 * launch path replays that recorded value; nothing here reads an ambient
 * `CODEX_PATH`, because which Codex a delegate runs is Consult's decision and
 * not the Host environment's.
 */
export function profileCodexPathEnv(
  registryId: string | undefined,
  codexPath: string | undefined,
): Record<string, string> {
  if (registryId !== "codex" || !codexPath) {
    return {};
  }
  return { CODEX_PATH: codexPath };
}

function homeMounts(home: string, relativePaths: string[]): ProfileMount[] {
  return relativePaths.map((relativePath) => ({
    source: path.join(home, relativePath),
    destination: path.join(SANDBOX_HOME, relativePath),
  }));
}
