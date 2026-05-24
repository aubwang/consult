import { stringFlag } from "../args.mjs";
import { profilesPath } from "../broker-endpoint.mjs";
import {
  loadProfiles as defaultLoadProfiles,
  setDefaultProfile as defaultSetDefaultProfile,
  setHostDefaultProfile as defaultSetHostDefaultProfile,
} from "../profiles.mjs";
import { profileErrorResult } from "./profile-errors.mjs";

export async function run(subcommand, parsedArgs) {
  return runAgents({ args: parsedArgs });
}

export async function runAgents({ args, deps = {} }) {
  const profilePath = profilesPath();
  if (args.flags?.set) {
    const host = stringFlag(args.flags?.host);
    try {
      if (host) {
        await (deps.setHostDefaultProfile ?? defaultSetHostDefaultProfile)(
          profilePath,
          host,
          args.flags.set,
        );
      } else {
        await (deps.setDefaultProfile ?? defaultSetDefaultProfile)(profilePath, args.flags.set);
      }
    } catch (error) {
      if (error.code === "UNKNOWN_PROFILE") {
        return { exitCode: 2, stdout: "", stderr: `no such profile: ${args.flags.set}\n` };
      }
      const profileResult = profileErrorResult(error);
      if (profileResult) {
        return profileResult;
      }
      throw error;
    }
    return {
      exitCode: 0,
      stdout: host
        ? `default for host ${host} set to ${args.flags.set}\n`
        : `default set to ${args.flags.set}\n`,
      stderr: "",
    };
  }
  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let profiles;
  try {
    profiles = await loadProfiles(profilePath);
  } catch (error) {
    const profileResult = profileErrorResult(error);
    if (profileResult) {
      return profileResult;
    }
    throw error;
  }
  if (Object.keys(profiles.profiles).length === 0) {
    return {
      exitCode: 0,
      stdout: "(no profiles configured; run /consult:setup)\n",
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

function profileRows(profiles) {
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

function renderProfilesTable(rows) {
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
