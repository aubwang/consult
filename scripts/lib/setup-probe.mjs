import { spawnSync } from "node:child_process";

export async function probeBinaryOnPath(binary, deps = {}) {
  const path = await (deps.whichBinary ?? defaultWhichBinary)(binary);
  if (!path) {
    return { found: false };
  }
  return { found: true, path };
}

export async function buildStatusTable(registry, profiles, deps = {}) {
  const rows = [];
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

function defaultWhichBinary(binary) {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}
