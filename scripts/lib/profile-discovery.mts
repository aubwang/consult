import type { ProfileRecord, ProfilesData } from "./profiles.mts";

export function hasNativeModelCatalogue(profile: ProfileRecord): boolean {
  return profile.registryId === "opencode" &&
    (profile.args.length === 0 || (profile.args.length === 1 && profile.args[0] === "acp"));
}

export function profileRoute(id: string, profile: ProfileRecord) {
  const confinement = ["codex", "claude"].includes(profile.registryId) ? "confined" : "inherit";
  const authorityArgs = ["--agent", id, "--read-only", "--sandbox", confinement];
  return {
    id,
    registryId: profile.registryId,
    confinement,
    requiresExplicitInheritance: confinement === "inherit",
    readiness: "unchecked" as const,
    lastVerifiedAt: profile.lastVerifiedAt ?? null,
    delegateArgs: ["delegate", ...authorityArgs, "--json", "--prompt", "-"],
    doctorArgs: ["doctor", ...authorityArgs, "--json"],
    modelDiscovery: hasNativeModelCatalogue(profile) ? "native-catalogue" : "acp-session",
    modelsArgs: ["models", "--agent", id,
      ...(confinement === "inherit" && !hasNativeModelCatalogue(profile) ? ["--sandbox", "inherit"] : []), "--json"],
  };
}

export function configuredDiscovery(profiles: ProfilesData) {
  return {
    defaultProfile: profiles.default,
    hostDefaults: profiles.hostDefaults ?? {},
    profiles: Object.entries(profiles.profiles).map(([id, profile]) => profileRoute(id, profile)),
    platform: process.platform,
    arch: process.arch,
    platformSupported: process.platform === "linux" || (process.platform === "darwin" && process.arch === "arm64"),
    limits: { generalExecution: false, inheritedReadOnly: "cooperative", confinedNestedJobs: false },
    commands: {
      models: ["models", "--match", "<model-name>", "--json"],
      wait: ["wait", "<job-id>", "--summary"],
      result: ["result", "<job-id>", "--json"],
      cancel: ["cancel", "<job-id>"],
    },
    input: "Argument arrays exclude the Consult executable. Pass the prompt on stdin. Add --background to delegate before submitting if the Host should continue working.",
  };
}
