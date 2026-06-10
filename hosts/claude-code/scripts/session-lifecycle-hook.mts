#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { brokersDir as defaultBrokersDir } from "../../../scripts/lib/broker-endpoint.mts";
import { teardownBrokerSession as defaultTeardownBrokerSession } from "../../../scripts/lib/broker-lifecycle.mts";
import type { TeardownBrokerSessionResult } from "../../../scripts/lib/broker-lifecycle.mts";
import { HOST_ENV, HOST_SESSION_ENV } from "../../../scripts/lib/host-identity.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../../../scripts/lib/workspace.mts";

const CLAUDE_HOST = "claude-code";

interface BrokerStateFile {
  jobId: string;
  host: string;
  hostSessionId: string;
  profile: string;
  [key: string]: unknown;
}

interface SessionLifecycleDeps {
  resolveWorkspaceRoot?: (cwd: string) => Promise<string>;
  brokersDir?: (workspaceRoot: string) => string;
  teardownBrokerSession?: (input: {
    workspaceRoot: string;
    jobId: string;
    host: string;
    hostSessionId: string;
    profile: string;
  }) => Promise<TeardownBrokerSessionResult>;
}

interface SessionLifecycleHookOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  deps?: SessionLifecycleDeps;
}

export async function handleSessionLifecycleHook(
  eventName: string,
  { cwd = process.cwd(), env = process.env, deps = {} }: SessionLifecycleHookOptions = {},
): Promise<void> {
  const resolveWorkspaceRoot = deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot;
  let workspaceRoot: string;
  try {
    workspaceRoot = await resolveWorkspaceRoot(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "NO_WORKSPACE") {
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

async function handleSessionStart({
  env,
}: {
  env: Record<string, string | undefined>;
}): Promise<void> {
  if (!env.CLAUDE_ENV_FILE || !env.CLAUDE_SESSION_ID) {
    return;
  }
  await appendEnvVars(env.CLAUDE_ENV_FILE, {
    [HOST_ENV]: CLAUDE_HOST,
    [HOST_SESSION_ENV]: env.CLAUDE_SESSION_ID,
  });
}

async function appendEnvVars(envFile: string, values: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await fsp.readFile(envFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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

async function handleSessionEnd({
  workspaceRoot,
  env,
  deps,
}: {
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  deps: SessionLifecycleDeps;
}): Promise<void> {
  const hostSessionId = env.CLAUDE_SESSION_ID;
  if (!hostSessionId) {
    return;
  }

  const brokersDir = deps.brokersDir ?? defaultBrokersDir;
  const teardownBrokerSession =
    deps.teardownBrokerSession ?? defaultTeardownBrokerSession;
  let entries: string[];
  try {
    entries = await fsp.readdir(brokersDir(workspaceRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

async function readSessionBrokerState(filePath: string): Promise<BrokerStateFile | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(content) as BrokerStateFile;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function main(): Promise<void> {
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
