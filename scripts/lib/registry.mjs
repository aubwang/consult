import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../registry.json",
);

export async function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  let registry;
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw registryError(
        `Registry file is malformed: ${registryPath}`,
        "REGISTRY_MALFORMED",
        registryPath,
      );
    }
    throw error;
  }
  validateRegistry(registry, registryPath);
  return registry;
}

export function findRegistryEntry(registry, id) {
  return registry.agents.find((agent) => agent.id === id) ?? null;
}

function validateRegistry(registry, registryPath) {
  if (!isRecord(registry)) {
    throw registryError(
      `Registry file is malformed: ${registryPath}`,
      "REGISTRY_MALFORMED",
      registryPath,
    );
  }
  if (registry.schemaVersion !== 1) {
    throw registryError("Registry schema mismatch", "REGISTRY_SCHEMA_MISMATCH", registryPath);
  }
  if (!Array.isArray(registry.agents)) {
    throw registryError(
      `Registry file is malformed: ${registryPath}`,
      "REGISTRY_MALFORMED",
      registryPath,
    );
  }
  for (const agent of registry.agents) {
    if (
      !isRecord(agent) ||
      !isRecord(agent.install) ||
      !isRecord(agent.supports) ||
      typeof agent.id !== "string" ||
      typeof agent.label !== "string" ||
      typeof agent.binary !== "string" ||
      !Array.isArray(agent.args) ||
      typeof agent.install.type !== "string" ||
      typeof agent.supports.resume !== "boolean" ||
      typeof agent.supports.load !== "boolean" ||
      ("notes" in agent && typeof agent.notes !== "string") ||
      !isValidInstall(agent.install)
    ) {
      throw registryError(
        `Registry file is malformed: ${registryPath}`,
        "REGISTRY_MALFORMED",
        registryPath,
      );
    }
  }
}

function registryError(message, code, registryPath) {
  const error = new Error(message);
  error.code = code;
  error.path = registryPath;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidInstall(install) {
  switch (install.type) {
    case "cargo":
    case "npm":
      return typeof install.cmd === "string";
    case "github-release":
      return (
        typeof install.repo === "string" &&
        typeof install.version === "string" &&
        typeof install.assetTemplate === "string"
      );
    default:
      return false;
  }
}
