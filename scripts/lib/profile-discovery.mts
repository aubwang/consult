import type { ProfileRecord, ProfilesData } from "./profiles.mts";

// Routing policy, not a model catalogue: exact model IDs still come from the
// selected adapter. Provider-qualified IDs and familiar family names identify
// the native adapter to inspect without translating IDs between providers.
export function nativeProfileForModel(value: string): "claude" | "codex" | null {
  const parts = value.toLowerCase().trim().split("/");
  if (parts.includes("anthropic")) return "claude";
  if (parts.includes("openai")) return "codex";
  for (const part of parts) {
    if (/^(?:claude|opus|sonnet|haiku|fable)(?:[-_.\s\[]|$)/u.test(part)) return "claude";
    if (/^(?:gpt|codex)(?:[-_.\d\s\[]|$)/u.test(part) || /^o\d+(?:[-_.\s\[]|$)/u.test(part)) return "codex";
  }
  if (parts.length === 1 && ["sol", "terra", "luna"].includes(parts[0])) return "codex";
  return null;
}

export function nativeRouting(profiles: ProfilesData) {
  const ids = (registryId: string) => Object.entries(profiles.profiles)
    .filter(([, profile]) => profile.registryId === registryId).map(([id]) => id);
  return {
    preferredProfiles: { claude: ids("claude"), openai: ids("codex") },
    nativeFailure: "report-without-rerouting",
    alternativeRoutes: "require-explicit-profile-selection",
    guidance: "Use native Claude Profiles for Claude models and native Codex Profiles for OpenAI models. Use opencode for other providers, or when the user explicitly requests it. A native setup, auth, or discovery failure does not authorize switching Profiles.",
  };
}

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
    nativeFor: profile.registryId === "claude" ? "claude" : profile.registryId === "codex" ? "openai" : null,
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
    routing: nativeRouting(profiles),
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
