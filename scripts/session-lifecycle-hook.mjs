#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { brokersDir as defaultBrokersDir } from "./lib/broker-endpoint.mjs";
import { teardownBrokerSession as defaultTeardownBrokerSession } from "./lib/broker-lifecycle.mjs";
import { HOST_ENV, HOST_SESSION_ENV } from "./lib/host-identity.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "./lib/workspace.mjs";

const CLAUDE_HOST = "claude-code";

export async function handleSessionLifecycleHook(
  eventName,
  { cwd = process.cwd(), env = process.env, deps = {} } = {},
) {
  const resolveWorkspaceRoot = deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot;
  let workspaceRoot;
  try {
    workspaceRoot = await resolveWorkspaceRoot(cwd);
  } catch (error) {
    if (error?.code === "NO_WORKSPACE") {
      return;
    }
    throw error;
  }

  if (eventName === "SessionStart") {
    await handleSessionStart({ env });
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd({
      workspaceRoot,
      env,
      deps,
    });
  }
}

async function handleSessionStart({ env }) {
  if (!env.CLAUDE_ENV_FILE || !env.CLAUDE_SESSION_ID) {
    return;
  }
  await appendEnvVars(env.CLAUDE_ENV_FILE, {
    [HOST_ENV]: CLAUDE_HOST,
    [HOST_SESSION_ENV]: env.CLAUDE_SESSION_ID,
  });
}

async function appendEnvVars(envFile, values) {
  let content = "";
  try {
    content = await fsp.readFile(envFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = content.split("\n").filter((line) => line.length > 0);
  for (const [name, value] of Object.entries(values)) {
    const replacement = `${name}=${value}`;
    const existingIndex = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (existingIndex === -1) {
      lines.push(replacement);
    } else {
      lines[existingIndex] = replacement;
    }
  }

  await fsp.mkdir(path.dirname(envFile), { recursive: true });
  const tmpFile = path.join(
    path.dirname(envFile),
    `.${path.basename(envFile)}.${process.pid}.tmp`,
  );
  await fsp.writeFile(tmpFile, `${lines.join("\n")}\n`, "utf8");
  await fsp.rename(tmpFile, envFile);
}

async function handleSessionEnd({ workspaceRoot, env, deps }) {
  const hostSessionId = env.CLAUDE_SESSION_ID;
  if (!hostSessionId) {
    return;
  }

  const brokersDir = deps.brokersDir ?? defaultBrokersDir;
  const teardownBrokerSession =
    deps.teardownBrokerSession ?? defaultTeardownBrokerSession;
  let entries;
  try {
    entries = await fsp.readdir(brokersDir(workspaceRoot));
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const state = await readSessionBrokerState(path.join(brokersDir(workspaceRoot), entry));
    if (!state) {
      continue;
    }
    if (state.host !== CLAUDE_HOST || state.hostSessionId !== hostSessionId || !state.profile) {
      continue;
    }
    await teardownBrokerSession({
      workspaceRoot,
      jobId: state.jobId,
      host: CLAUDE_HOST,
      hostSessionId,
      profile: state.profile,
    });
  }
}

async function readSessionBrokerState(filePath) {
  let content;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function main() {
  await handleSessionLifecycleHook(process.argv[2] ?? "");
}

const isCli = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
