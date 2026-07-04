import fs from "node:fs/promises";
import path from "node:path";

import { profilesPath } from "../broker-endpoint.mts";
import {
  loadProfiles as defaultLoadProfiles,
  saveProfiles as defaultSaveProfiles,
  setDefaultProfile as defaultSetDefaultProfile,
} from "../profiles.mts";
import type { ProfilesData } from "../profiles.mts";
import { findRegistryEntry, loadRegistry as defaultLoadRegistry } from "../registry.mts";
import type { Registry } from "../registry.mts";
import { installAndVerify as defaultInstallAndVerify } from "../setup-install.mts";
import type { InstallAndVerifyOptions, InstallDeps, InstallResult } from "../setup-install.mts";
import { buildStatusTable } from "../setup-probe.mts";
import type { ProbeDeps, StatusRow } from "../setup-probe.mts";
import { missingFlagValueError, stringFlag } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import type { CliResult, CodedError } from "./job-record-errors.mts";
import { profileErrorResult } from "./profile-errors.mts";

export interface SetupDeps extends InstallDeps, ProbeDeps {
  loadRegistry?: () => Promise<Registry>;
  loadProfiles?: (profilePath: string) => Promise<ProfilesData>;
  saveProfiles?: (profilePath: string, data: ProfilesData) => Promise<void>;
  setDefaultProfile?: (profilePath: string, name: string) => Promise<void>;
  installAndVerify?: (options: InstallAndVerifyOptions) => Promise<InstallResult>;
}

export async function run(subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult> {
  return runSetup({ args: parsedArgs });
}

export async function runSetup({
  args,
  deps = {},
}: {
  args: ParsedArgs;
  deps?: SetupDeps;
}): Promise<CliResult> {
  const profilePath = profilesPath();
  const usageError = missingFlagValueError(args.flags, ["set-default", "install"]);
  if (usageError) {
    return { exitCode: 2, stdout: "", stderr: `${usageError}\n` };
  }
  const loadRegistry = deps.loadRegistry ?? defaultLoadRegistry;
  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let registry: Registry;
  try {
    registry = await loadRegistry();
  } catch (error) {
    const registryResult = registryErrorResult(error as CodedError);
    if (registryResult) {
      return registryResult;
    }
    throw error;
  }

  const setDefaultName = stringFlag(args.flags?.["set-default"]);
  if (setDefaultName) {
    return setDefault({ profilePath, name: setDefaultName, deps });
  }

  const installId = stringFlag(args.flags?.install);
  if (installId) {
    return installProfile({
      profilePath,
      registry,
      id: installId,
      deps,
    });
  }

  let profiles: ProfilesData;
  try {
    profiles = await loadProfiles(profilePath);
  } catch (error) {
    const profileResult = profileErrorResult(error as CodedError);
    if (profileResult) {
      return profileResult;
    }
    throw error;
  }
  const registryStatus: StatusRow[] = await buildStatusTable(registry, profiles, deps);
  if (args.flags?.json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        schemaVersion: registry.schemaVersion,
        registry: registryStatus,
        profiles,
      })}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: renderStatusTable(registryStatus),
    stderr: "",
  };
}

async function installProfile({
  profilePath,
  registry,
  id,
  deps,
}: {
  profilePath: string;
  registry: Registry;
  id: string;
  deps: SetupDeps;
}): Promise<CliResult> {
  const registryEntry = findRegistryEntry(registry, id);
  if (!registryEntry) {
    return { exitCode: 2, stdout: "", stderr: `unknown registry entry: ${id}\n` };
  }

  const installAndVerify = deps.installAndVerify ?? defaultInstallAndVerify;
  const result = await installAndVerify({ registryEntry, deps });
  if (!result.ok) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: renderInstallFailure(result),
    };
  }

  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  const saveProfiles = deps.saveProfiles ?? defaultSaveProfiles;
  let profiles: ProfilesData;
  try {
    profiles = await loadProfiles(profilePath);
  } catch (error) {
    const profileResult = profileErrorResult(error as CodedError);
    if (profileResult) {
      return profileResult;
    }
    throw error;
  }
  profiles.profiles[id] = result.profile;
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await saveProfiles(profilePath, profiles);

  return {
    exitCode: 0,
    stdout: `verified ${id}\n`,
    stderr: "",
  };
}

async function setDefault({
  profilePath,
  name,
  deps,
}: {
  profilePath: string;
  name: string;
  deps: SetupDeps;
}): Promise<CliResult> {
  try {
    await (deps.setDefaultProfile ?? defaultSetDefaultProfile)(profilePath, name);
  } catch (error) {
    if ((error as CodedError).code === "UNKNOWN_PROFILE") {
      return { exitCode: 2, stdout: "", stderr: `no such profile: ${name}\n` };
    }
    const profileResult = profileErrorResult(error as CodedError);
    if (profileResult) {
      return profileResult;
    }
    throw error;
  }

  return {
    exitCode: 0,
    stdout: `default set to ${name}\n`,
    stderr: "",
  };
}

function renderStatusTable(rows: StatusRow[]): string {
  const lines = ["id\tlabel\tinstalled\tdefault\tlastVerifiedAt\tnotes"];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.label,
        row.installed ? "yes" : "no",
        row.isDefault ? "yes" : "no",
        row.lastVerifiedAt ?? "-",
        row.notes ?? "-",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderInstallFailure(result: Extract<InstallResult, { ok: false }>): string {
  const lines = [`${result.stage}: ${result.message}`];
  if (result.captured?.stdout) {
    lines.push(result.captured.stdout);
  }
  if (result.captured?.stderr) {
    lines.push(result.captured.stderr);
  }
  return `${lines.join("\n")}\n`;
}

function registryErrorResult(error: CodedError): CliResult | null {
  if (error.code === "REGISTRY_MALFORMED") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `registry malformed: ${error.path}\n`,
    };
  }
  if (error.code === "REGISTRY_SCHEMA_MISMATCH") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `registry schema mismatch: ${error.path}\n`,
    };
  }
  return null;
}
