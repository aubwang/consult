import { spawnSync } from "node:child_process";

import type { ProfilesData } from "./profiles.mts";
import type { Registry, RegistryEntry } from "./registry.mts";

export type ProbeResult = { found: false } | { found: true; path: string };

export interface ProbeDeps {
  whichBinary?: (binary: string) => Promise<string | null> | string | null;
}

export interface StatusRow {
  id: string;
  label: string;
  installed: boolean;
  isDefault: boolean;
  lastVerifiedAt: string | undefined;
  notes: string | null;
  registryEntry: RegistryEntry;
}

export async function probeBinaryOnPath(
  binary: string,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const path = await (deps.whichBinary ?? defaultWhichBinary)(binary);
  if (!path) {
    return { found: false };
  }
  return { found: true, path };
}

export async function buildStatusTable(
  registry: Registry,
  profiles: ProfilesData,
  deps: ProbeDeps = {},
): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  for (const registryEntry of registry.agents) {
    const profile = profiles.profiles[registryEntry.id];
    const probe = await probeBinaryOnPath(registryEntry.binary, deps);
    rows.push({
      id: registryEntry.id,
      label: registryEntry.label,
      installed: Boolean(profile) || probe.found,
      isDefault: profiles.default === registryEntry.id,
      lastVerifiedAt: profile?.lastVerifiedAt,
      notes: registryEntry.notes ?? null,
      registryEntry,
    });
  }
  return rows;
}

function defaultWhichBinary(binary: string): string | null {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}
