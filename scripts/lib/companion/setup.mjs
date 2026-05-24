import fs from "node:fs/promises";
import path from "node:path";

import { profilesPath } from "../broker-endpoint.mjs";
import {
  loadProfiles as defaultLoadProfiles,
  saveProfiles as defaultSaveProfiles,
  setDefaultProfile as defaultSetDefaultProfile,
} from "../profiles.mjs";
import { findRegistryEntry, loadRegistry as defaultLoadRegistry } from "../registry.mjs";
import { installAndVerify as defaultInstallAndVerify } from "../setup-install.mjs";
import { buildStatusTable } from "../setup-probe.mjs";
import { profileErrorResult } from "./profile-errors.mjs";

export async function run(subcommand, parsedArgs) {
  return runSetup({ args: parsedArgs });
}

export async function runSetup({ args, deps = {} }) {
  const profilePath = profilesPath();
  const loadRegistry = deps.loadRegistry ?? defaultLoadRegistry;
  const loadProfiles = deps.loadProfiles ?? defaultLoadProfiles;
  let registry;
  try {
    registry = await loadRegistry();
  } catch (error) {
    const registryResult = registryErrorResult(error);
    if (registryResult) {
      return registryResult;
    }
    throw error;
  }

  if (args.flags?.["set-default"]) {
    return setDefault({ profilePath, name: args.flags["set-default"], deps });
  }

  if (args.flags?.install) {
    return installProfile({
      profilePath,
      registry,
      id: args.flags.install,
      deps,
    });
  }

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
  const registryStatus = await buildStatusTable(registry, profiles, deps);
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

async function installProfile({ profilePath, registry, id, deps }) {
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
  profiles.profiles[id] = result.profile;
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await saveProfiles(profilePath, profiles);

  return {
    exitCode: 0,
    stdout: `verified ${id}\n`,
    stderr: "",
  };
}

async function setDefault({ profilePath, name, deps }) {
  try {
    await (deps.setDefaultProfile ?? defaultSetDefaultProfile)(profilePath, name);
  } catch (error) {
    if (error.code === "UNKNOWN_PROFILE") {
      return { exitCode: 2, stdout: "", stderr: `no such profile: ${name}\n` };
    }
    const profileResult = profileErrorResult(error);
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

function renderStatusTable(rows) {
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

function renderInstallFailure(result) {
  const lines = [`${result.stage}: ${result.message}`];
  if (result.captured?.stdout) {
    lines.push(result.captured.stdout);
  }
  if (result.captured?.stderr) {
    lines.push(result.captured.stderr);
  }
  return `${lines.join("\n")}\n`;
}

function registryErrorResult(error) {
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
