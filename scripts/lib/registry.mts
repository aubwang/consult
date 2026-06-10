import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./objects.mts";

const DEFAULT_REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../registry.json",
);

export interface RegistryShellInstall {
  type: "cargo" | "npm";
  cmd: string;
}

export interface RegistryGithubReleaseInstall {
  type: "github-release";
  repo: string;
  version: string;
  assetTemplate: string;
  binaryInArchive?: string;
}

export type RegistryInstall = RegistryShellInstall | RegistryGithubReleaseInstall;

export interface RegistrySupports {
  resume: boolean;
  load: boolean;
}

export interface RegistryEntry {
  id: string;
  label: string;
  binary: string;
  args: string[];
  install: RegistryInstall;
  supports: RegistrySupports;
  notes?: string;
  advertisesReview?: boolean;
}

export interface Registry {
  schemaVersion: number;
  agents: RegistryEntry[];
}

export interface RegistryError extends Error {
  code: string;
  path: string;
}

export async function loadRegistry(
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Promise<Registry> {
  let registry: unknown;
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

export function findRegistryEntry(registry: Registry, id: string): RegistryEntry | null {
  return registry.agents.find((agent) => agent.id === id) ?? null;
}

function validateRegistry(registry: unknown, registryPath: string): asserts registry is Registry {
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
  for (const agent of registry.agents as unknown[]) {
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

function registryError(message: string, code: string, registryPath: string): RegistryError {
  const error = new Error(message) as RegistryError;
  error.code = code;
  error.path = registryPath;
  return error;
}

function isValidInstall(install: Record<string, unknown>): boolean {
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
