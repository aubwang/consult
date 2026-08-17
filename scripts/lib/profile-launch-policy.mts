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
 * Extra launch arguments that pin a delegated Profile's own permission layer
 * to the Job mode. Copilot CLI honors `--deny-tool` above every other
 * permission source — `--allow-all`, `COPILOT_ALLOW_ALL`, and approvals
 * persisted in `~/.copilot` — so these denies hold even when the inherited
 * Host environment or saved state would otherwise auto-approve tools without
 * a `session/request_permission` round-trip. Execute stays denied in every
 * Job mode and fetch requires confinement, which copilot does not have, so
 * `shell` and `url` are always denied; web fetches request the `url`
 * permission kind, not a `web_fetch` tool name. `write` is denied unless the
 * Job mode grants writes, and an unknown mode gets the read-only set: deny
 * more, not less. `--no-auto-update` keeps the verified binary from swapping
 * itself out mid-Job. These pins govern model-initiated tool calls only;
 * user-configured Copilot hooks and MCP servers run outside them.
 */
export function profileModeArgs(
  registryId: string | undefined,
  mode: string | undefined,
): string[] {
  if (registryId !== "copilot") {
    return [];
  }
  if (mode === "write") {
    return ["--no-auto-update", "--deny-tool=shell,url"];
  }
  return ["--no-auto-update", "--deny-tool=shell,write,url"];
}

/**
 * Ambient environment keys that must be absent from a delegated Profile's
 * launch. `COPILOT_ALLOW_ALL` binds to Copilot's boolean `--allow-all-tools`
 * option, and a bound boolean treats any defined value — including "" and
 * "false" — as enabled, auto-approving every tool without a
 * `session/request_permission` round-trip. Overlaying a value cannot disable
 * it; the key has to be deleted from the child environment.
 */
export function profileStripEnvKeys(registryId: string | undefined): string[] {
  if (registryId !== "copilot") {
    return [];
  }
  return ["COPILOT_ALLOW_ALL"];
}

/**
 * Minimum Copilot CLI version for delegated launches. ACP permission flags
 * landed at 0.0.400, but permission behavior in ACP mode kept consolidating
 * until 1.0.60 ("--available-tools, --excluded-tools ... apply correctly in
 * ACP mode", "allow_all config option correctly applies"), so older binaries
 * can accept the `--deny-tool` pins without honoring the surrounding
 * permission model. The floor is enforced at setup, preflight, and every
 * turn (auto-update can change the binary between them), keyed on the
 * agent-reported `agentInfo` rather than the registry id so aliased or
 * custom Profiles that launch Copilot are covered too.
 */
export const COPILOT_MIN_VERSION = "1.0.60";

export function copilotAgentVersionDiagnostic(capabilities: unknown): string | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const agentInfo = (capabilities as { agentInfo?: unknown }).agentInfo;
  if (typeof agentInfo !== "object" || agentInfo === null) return null;
  const { name, version } = agentInfo as { name?: unknown; version?: unknown };
  if (name !== "Copilot") return null;
  if (typeof version === "string" && versionAtLeast(version, COPILOT_MIN_VERSION)) {
    return null;
  }
  const reported = typeof version === "string" ? version : "unknown";
  return (
    `Copilot CLI ${reported} is older than the supported ${COPILOT_MIN_VERSION}; ` +
    `its ACP permission handling predates the launch pins Consult relies on. ` +
    `Update with npm install -g @github/copilot@latest and retry`
  );
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parsedActual = parseReleaseVersion(actual);
  const parsedMinimum = parseReleaseVersion(minimum);
  if (!parsedActual || !parsedMinimum) return false;
  for (let index = 0; index < parsedActual.length; index += 1) {
    if (parsedActual[index] !== parsedMinimum[index]) {
      return parsedActual[index] > parsedMinimum[index];
    }
  }
  return true;
}

function parseReleaseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether an inherited-authority preflight must also create a session before
 * reporting ready. Copilot CLI's ACP `initialize` succeeds while logged out
 * and only `session/new` raises `Authentication required`, so an
 * initialize-only probe would report an unauthenticated Profile as ready and
 * defer the failure to the first delegated prompt. The probe sends no model
 * prompt.
 */
export function profilePreflightsSession(registryId: string | undefined): boolean {
  return registryId === "copilot";
}

/**
 * Whether Consult refuses to reopen this Profile's Sessions even when the
 * agent advertises `session/load`. Copilot persists tool approvals across
 * sessions (`/allow-all`, `~/.copilot/permissions-config.json`), and a loaded
 * Session restores that state — so reopening could resume with wider
 * permissions than the new Job's authority. Rejected until that persisted
 * state is bounded.
 */
export function profileRejectsResume(registryId: string | undefined): boolean {
  return registryId === "copilot";
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
