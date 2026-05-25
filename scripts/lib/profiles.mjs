import fs from "node:fs/promises";

import { isRecord } from "./objects.mjs";
import { atomicWriteJson } from "./state.mjs";

export const PROFILES_SCHEMA_VERSION = 1;

export async function loadProfiles(profilesPath) {
  let contents;
  try {
    contents = await fs.readFile(profilesPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyProfiles();
    }
    throw error;
  }

  let data;
  try {
    data = JSON.parse(contents);
  } catch {
    throw profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
  }

  if (!isRecord(data)) {
    throw profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
  }
  if (data.schemaVersion !== PROFILES_SCHEMA_VERSION) {
    throw profilesError("Profiles schema mismatch", "PROFILES_SCHEMA_MISMATCH", profilesPath);
  }
  data.hostDefaults ??= {};
  if (!isRecord(data.profiles)) {
    throw profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
  }
  if (
    data.default !== null &&
    (typeof data.default !== "string" || !Object.hasOwn(data.profiles, data.default))
  ) {
    throw profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
  }
  if (!isRecord(data.hostDefaults)) {
    throw profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
  }
  validateProfiles(data.profiles, profilesPath);
  for (const [host, profileName] of Object.entries(data.hostDefaults)) {
    if (typeof profileName !== "string" || !Object.hasOwn(data.profiles, profileName)) {
      const error = profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
      error.host = host;
      throw error;
    }
  }
  return data;
}

export async function saveProfiles(profilesPath, data) {
  await atomicWriteJson(profilesPath, data);
}

export async function setDefaultProfile(profilesPath, name) {
  const data = await loadProfiles(profilesPath);
  if (!Object.hasOwn(data.profiles, name)) {
    const error = new Error("Unknown profile");
    error.code = "UNKNOWN_PROFILE";
    throw error;
  }
  data.default = name;
  await saveProfiles(profilesPath, data);
}

export async function setHostDefaultProfile(profilesPath, host, name) {
  const data = await loadProfiles(profilesPath);
  if (!Object.hasOwn(data.profiles, name)) {
    const error = new Error("Unknown profile");
    error.code = "UNKNOWN_PROFILE";
    throw error;
  }
  data.hostDefaults ??= {};
  data.hostDefaults[host] = name;
  await saveProfiles(profilesPath, data);
}

function emptyProfiles() {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    default: null,
    hostDefaults: {},
    profiles: {},
  };
}

function validateProfiles(profiles, profilesPath) {
  for (const [profileName, profile] of Object.entries(profiles)) {
    if (
      !isRecord(profile) ||
      typeof profile.registryId !== "string" ||
      typeof profile.binary !== "string" ||
      !Array.isArray(profile.args) ||
      !isRecord(profile.env) ||
      typeof profile.installedAt !== "string"
    ) {
      const error = profilesError("Profiles file is malformed", "PROFILES_MALFORMED", profilesPath);
      error.profileName = profileName;
      throw error;
    }
    profile.installedVia ??= "registry";
  }
}

function profilesError(message, code, profilesPath) {
  const error = new Error(message);
  error.code = code;
  error.path = profilesPath;
  return error;
}
