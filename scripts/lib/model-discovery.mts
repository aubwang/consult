import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasNativeModelCatalogue } from "./profile-discovery.mts";
import type { ProfileRecord } from "./profiles.mts";
import type { JobConfinement } from "./job-authority.mts";

export const MODELS_SCHEMA_VERSION = 1;

export interface ModelCatalogue {
  source: "opencode-catalogue" | "acp-session";
  models: string[];
}

export async function discoverProfileModels(
  profile: ProfileRecord,
  workspaceRoot: string,
  confinement: JobConfinement,
): Promise<ModelCatalogue> {
  // This is a catalogue command, not an ACP session or model turn. Preserve
  // the configured executable and environment; do not substitute a PATH binary.
  if (hasNativeModelCatalogue(profile)) {
    const { stdout } = await promisify(execFile)(profile.binary, ["models"], {
      cwd: workspaceRoot, env: { ...process.env, ...profile.env, NO_COLOR: "1" },
      timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    const models = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (models.some((id) => !/^[^\s/]+\/[^\s]+$/u.test(id))) {
      throw new Error("Invalid model catalogue output");
    }
    return { source: "opencode-catalogue", models: [...new Set(models)].sort() };
  }
  const { preflightJobAuthority, probeInheritedProfileLaunch } = await import("./job-authority-preflight.mts");
  const { probeConfinedSandboxRuntime } = await import("./sandbox-runtime-launch.mts");
  const result = await preflightJobAuthority({
    authority: { schemaVersion: 1, mode: "read-only", confinement, allowFetch: false, allowExecute: false },
    workspaceRoot, profile: profile.registryId, profileRegistryId: profile.registryId,
    profileLaunch: profile, oauthRefreshSkewMs: 0, discoverModels: true,
  }, { probeConfined: probeConfinedSandboxRuntime, probeInherited: probeInheritedProfileLaunch });
  if (!result.ok) throw Object.assign(new Error("Model discovery failed; run Doctor for this Profile"), { code: result.diagnostic.code });
  return { source: "acp-session", models: result.models ?? [] };
}
