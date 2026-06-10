import fs from "node:fs/promises";

import { isRecord } from "./objects.mts";
import { atomicWriteJson } from "./state.mts";

export const PROFILES_SCHEMA_VERSION = 1;

export interface ProfileRecord {
  registryId: string;
  binary: string;
  args: string[];
  env: Record<string, string>;
  installedAt: string;
  installedVia?: string;
  lastVerifiedAt?: string;
}

export interface ProfilesData {
  schemaVersion: number;
  default: string | null;
  hostDefaults?: Record<string, string>;
  profiles: Record<string, ProfileRecord>;
}

export interface ProfilesError extends Error {
  code: string;
  path?: string;
  host?: string;
  profileName?: string;
}

export async function loadProfiles(profilesPath: string): Promise<ProfilesData> {
  let contents: string;
  try {
    contents = await fs.readFile(profilesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return emptyProfiles();
    }
    throw error;
  }

  let data: unknown;
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
  return data as ProfilesData;
}

export async function saveProfiles(profilesPath: string, data: ProfilesData): Promise<void> {
  await atomicWriteJson(profilesPath, data);
}

export async function setDefaultProfile(profilesPath: string, name: string): Promise<void> {
  const data = await loadProfiles(profilesPath);
  if (!Object.hasOwn(data.profiles, name)) {
    const error = new Error("Unknown profile") as ProfilesError;
    error.code = "UNKNOWN_PROFILE";
    throw error;
  }
  data.default = name;
  await saveProfiles(profilesPath, data);
}

export async function setHostDefaultProfile(
  profilesPath: string,
  host: string,
  name: string,
): Promise<void> {
  const data = await loadProfiles(profilesPath);
  if (!Object.hasOwn(data.profiles, name)) {
    const error = new Error("Unknown profile") as ProfilesError;
    error.code = "UNKNOWN_PROFILE";
    throw error;
  }
  data.hostDefaults ??= {};
  data.hostDefaults[host] = name;
  await saveProfiles(profilesPath, data);
}

function emptyProfiles(): ProfilesData {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    default: null,
    hostDefaults: {},
    profiles: {},
  };
}

function validateProfiles(profiles: Record<string, unknown>, profilesPath: string): void {
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

function profilesError(message: string, code: string, profilesPath: string): ProfilesError {
  const error = new Error(message) as ProfilesError;
  error.code = code;
  error.path = profilesPath;
  return error;
}
