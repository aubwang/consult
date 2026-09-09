import { boolFlag, invalidBooleanFlagValueError, missingFlagValueError, stringFlag, unsupportedFlagError, type ParsedArgs } from "../args.mts";
import { profilesPath } from "../broker-endpoint.mts";
import { loadProfiles, type ProfilesData, type ProfileRecord } from "../profiles.mts";
import { profileRoute, hasNativeModelCatalogue, nativeProfileForModel, nativeRouting } from "../profile-discovery.mts";
import { MODELS_SCHEMA_VERSION, discoverProfileModels, type ModelCatalogue } from "../model-discovery.mts";
import { resolveWorkspaceRoot } from "../workspace.mts";
import type { JobConfinement } from "../job-authority.mts";
import type { CliResult } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";
import { resolvePackageVersion } from "./version.mts";

interface ModelsDeps {
  loadProfiles?: (file: string) => Promise<ProfilesData>;
  workspace?: () => Promise<string>;
  discover?: (profile: ProfileRecord, workspace: string, confinement: JobConfinement) => Promise<ModelCatalogue>;
  version?: () => string;
}

export async function run(_command: string, args: ParsedArgs): Promise<CliResult> {
  return runModels({ args });
}

export async function runModels({ args, deps = {} }: { args: ParsedArgs; deps?: ModelsDeps }): Promise<CliResult> {
  const error = unsupportedFlagError(args.flags, ["agent", "profile", "match", "limit", "offset", "sandbox", "json"]) ??
    invalidBooleanFlagValueError(args.flags) ??
    missingFlagValueError(args.flags, ["agent", "profile", "match", "limit", "offset", "sandbox"]);
  if (error) return usage(error);
  if (args.positional.length) return usage(`unexpected argument: ${args.positional[0]}`);
  const selected = stringFlag(args.flags.agent) ?? stringFlag(args.flags.profile);
  if (args.flags.agent && args.flags.profile && args.flags.agent !== args.flags.profile) return usage("--agent and --profile must select the same Profile");
  const sandbox = stringFlag(args.flags.sandbox);
  if (sandbox && !["confined", "inherit"].includes(sandbox)) return usage("--sandbox must be confined or inherit");
  if (sandbox && !selected) return usage("--sandbox requires --agent so initialization authority is scoped to one Profile");
  const limit = numberFlag(args, "limit", 20);
  const offset = numberFlag(args, "offset", 0);
  if (limit === null || limit < 1 || limit > 200 || offset === null) return usage("--limit must be 1–200 and --offset must be a nonnegative integer");
  let profiles: ProfilesData;
  try { profiles = await (deps.loadProfiles ?? loadProfiles)(profilesPath()); }
  catch (error) {
    const result = profileErrorResult(error as any);
    if (result) return result;
    throw error;
  }
  if (selected && !Object.hasOwn(profiles.profiles, selected)) return usage(`no such profile: ${selected}`);
  const match = stringFlag(args.flags.match)?.toLowerCase().trim() ?? "";
  const preferredNative = selected ? null : nativeProfileForModel(match);
  const entries = Object.entries(profiles.profiles)
    .filter(([id, profile]) => selected ? selected === id : !preferredNative || profile.registryId === preferredNative)
    .sort(([a], [b]) => a.localeCompare(b));
  const workspace = entries.length ? await (deps.workspace ?? resolveWorkspaceRoot)() : "";
  const diagnostics: Array<{ profile: string; code: string; message: string; nextArgs: string[] }> = [];
  if (preferredNative && entries.length === 0) diagnostics.push({
    profile: preferredNative, code: "NATIVE_PROFILE_NOT_CONFIGURED",
    message: `Configure the native ${preferredNative} Profile for this model family. Alternative Profiles require an explicit --agent selection.`,
    nextArgs: ["setup", "--install", preferredNative],
  });
  const routes: Array<{ profile: string; model: string; source: string; confinement: string; requiresExplicitInheritance: boolean; delegateArgs: string[]; doctorArgs: string[] }> = [];
  let omittedAlternateRoutes = 0;
  // The pinned sandbox runtime owns process-global state. Confined probes must
  // finish and dispose before another Profile is initialized in this process.
  for (const [id, profile] of entries) {
    const route = profileRoute(id, profile);
    const catalogueOnly = hasNativeModelCatalogue(profile);
    const confinement = (sandbox ?? route.confinement) as JobConfinement;
    if (confinement === "inherit" && sandbox !== "inherit" && !catalogueOnly) {
      diagnostics.push({ profile: id, code: "INHERITANCE_REQUIRED", message: "ACP model discovery starts this Profile with ambient Host authority; choose inheritance explicitly.", nextArgs: ["models", "--agent", id, "--sandbox", "inherit", "--json"] });
      continue;
    }
    if (sandbox === "confined" && catalogueOnly) {
      diagnostics.push({ profile: id, code: "CONFINEMENT_UNAVAILABLE", message: "opencode catalogue discovery runs its native metadata command with Host authority.", nextArgs: ["models", "--agent", id, "--json"] });
      continue;
    }
    try {
      const catalogue = await (deps.discover ?? discoverProfileModels)(profile, workspace, confinement);
      if (catalogue.models.length === 0) diagnostics.push({ profile: id, code: "NO_ADVERTISED_MODELS", message: "The Profile returned no model catalogue; this does not establish that it cannot delegate.", nextArgs: route.doctorArgs });
      for (const model of catalogue.models) {
        const native = nativeProfileForModel(model);
        if (!selected && native && profile.registryId !== native) {
          omittedAlternateRoutes++;
          continue;
        }
        routes.push({ profile: id, model, source: catalogue.source, confinement,
          requiresExplicitInheritance: confinement === "inherit",
          delegateArgs: ["delegate", "--agent", id, "--model", model, "--read-only", "--sandbox", confinement, "--json", "--prompt", "-"],
          doctorArgs: ["doctor", "--agent", id, "--read-only", "--sandbox", confinement, "--json"],
        });
      }
    } catch {
      // Provider stderr and arbitrary error text may contain credentials. Keep
      // discovery failures compact; Doctor owns the detailed diagnostic path.
      diagnostics.push({ profile: id, code: "MODEL_DISCOVERY_FAILED", message: "Could not inspect this Profile's advertised models. Run Doctor for setup, authentication, or launch diagnostics.", nextArgs: ["doctor", "--agent", id, "--read-only", "--sandbox", confinement, "--json"] });
    }
  }
  // A family query must find the native adapter even when its IDs are short
  // names such as "sonnet" and never contain the word "claude" or "anthropic".
  const familyQuery = !selected && ["claude", "anthropic", "openai", "codex"].includes(match);
  const matching = routes.filter((route) => familyQuery || route.model.toLowerCase().includes(match));
  const report = {
    schemaVersion: MODELS_SCHEMA_VERSION,
    version: (deps.version ?? resolvePackageVersion)(),
    readiness: "advertised-only",
    routing: { ...nativeRouting(profiles), preferredNativeProfile: preferredNative, explicitProfile: selected ?? null, omittedAlternateRoutes },
    complete: diagnostics.length === 0,
    total: matching.length,
    offset,
    nextOffset: offset + limit < matching.length ? offset + limit : null,
    models: matching.slice(offset, offset + limit),
    diagnostics,
  };
  return {
    exitCode: diagnostics.some((item) => ["MODEL_DISCOVERY_FAILED", "NATIVE_PROFILE_NOT_CONFIGURED"].includes(item.code)) ? 1 : 0,
    stdout: boolFlag(args.flags.json) ? `${JSON.stringify(report)}\n` : [
      `consult ${report.version} — ${report.total} matching advertised model(s); readiness unchecked`,
      "profile\tmodel\tconfinement",
      ...report.models.map((row) => `${row.profile}\t${row.model}\t${row.confinement}`),
      ...diagnostics.map((item) => `${item.profile}: ${item.code}: ${item.message}`),
      ...(!selected ? ["Claude/OpenAI use native adapters. Select --agent explicitly to inspect alternate routes."] : []),
      ...(report.nextOffset === null ? [] : [`More results: repeat with --offset ${report.nextOffset}`]),
      "Use --json for exact delegate argument arrays. Supply the prompt on stdin.", "",
    ].join("\n"),
    stderr: "",
  };
}

function numberFlag(args: ParsedArgs, key: string, fallback: number): number | null {
  const raw = stringFlag(args.flags[key]);
  if (raw === undefined) return fallback;
  return /^\d+$/u.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
}
function usage(message: string): CliResult { return { exitCode: 2, stdout: "", stderr: `${message}\n` }; }
