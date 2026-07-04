import { missingFlagValueError, stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { profilesPath } from "../broker-endpoint.mts";
import {
  loadProfiles as defaultLoadProfiles,
  setDefaultProfile as defaultSetDefaultProfile,
  setHostDefaultProfile as defaultSetHostDefaultProfile,
} from "../profiles.mts";
import type { ProfilesData } from "../profiles.mts";
import type { CliResult } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";

interface ProfileRow {
  id: string;
  registryId: string;
  binary: string;
  default: boolean;
  hostDefaults: string[];
  lastVerifiedAt: string | null;
}

interface AgentsDeps {
  loadProfiles?: (path: string) => Promise<ProfilesData>;
  setDefaultProfile?: (path: string, name: string) => Promise<void>;
  setHostDefaultProfile?: (path: string, host: string, name: string) => Promise<void>;
}

interface RunAgentsOptions {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: AgentsDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult> {
  return runAgents({ args: parsedArgs });
}

export async function runAgents({ args, deps = {} }: RunAgentsOptions): Promise<CliResult> {
  const profilePath = profilesPath();
  const usageError = missingFlagValueError(args.flags, ["set", "host"]);
  if (usageError) {
    return { exitCode: 2, stdout: "", stderr: `${usageError}\n` };
  }
  const setProfile = stringFlag(args.flags?.set);
  if (setProfile) {
    const host = stringFlag(args.flags?.host);
    try {
      if (host) {
        await (deps.setHostDefaultProfile ?? defaultSetHostDefaultProfile)(
          profilePath,
          host,
          setProfile,
        );
      } else {
        await (deps.setDefaultProfile ?? defaultSetDefaultProfile)(profilePath, setProfile);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "UNKNOWN_PROFILE") {
        return { exitCode: 2, stdout: "", stderr: `no such profile: ${setProfile}\n` };
      }
      const profileResult = profileErrorResult(error as { code?: string; path?: string });
      if (profileResult) {
        return profileResult;
      }
      throw error;
    }
    return {
      exitCode: 0,
      stdout: host
        ? `default for host ${host} set to ${setProfile}\n`
        : `default set to ${setProfile}\n`,
      stderr: "",
    };
  }
  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let profiles: ProfilesData;
  try {
    profiles = await loadProfiles(profilePath);
  } catch (error) {
    const profileResult = profileErrorResult(error as { code?: string; path?: string });
    if (profileResult) {
      return profileResult;
    }
    throw error;
  }
  if (Object.keys(profiles.profiles).length === 0) {
    return {
      exitCode: 0,
      stdout: "(no profiles configured; run 'consult setup')\n",
      stderr: "",
    };
  }
  const rows = profileRows(profiles);
  return {
    exitCode: 0,
    stdout: args.flags?.json ? `${JSON.stringify(rows)}\n` : renderProfilesTable(rows),
    stderr: "",
  };
}

function profileRows(profiles: ProfilesData): ProfileRow[] {
  return Object.entries(profiles.profiles).map(([id, profile]) => ({
    id,
    registryId: profile.registryId,
    binary: profile.binary,
    default: profiles.default === id,
    hostDefaults: Object.entries(profiles.hostDefaults ?? {})
      .filter(([, profileName]) => profileName === id)
      .map(([host]) => host),
    lastVerifiedAt: profile.lastVerifiedAt ?? null,
  }));
}

function renderProfilesTable(rows: ProfileRow[]): string {
  const lines = ["id\tregistryId\tbinary\tdefault\thostDefaults\tlastVerifiedAt"];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.registryId,
        row.binary,
        row.default ? "yes" : "no",
        row.hostDefaults.length > 0 ? row.hostDefaults.join(",") : "-",
        row.lastVerifiedAt ?? "-",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}
