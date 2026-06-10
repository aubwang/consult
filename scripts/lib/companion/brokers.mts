import fs from "node:fs/promises";
import path from "node:path";

import { brokersDir as defaultBrokersDir } from "../broker-endpoint.mts";
import {
  brokerPidFilePath,
  cleanupBrokerFiles as defaultCleanupBrokerFiles,
  pidAlive as defaultPidAlive,
  teardownBrokerSession as defaultTeardownBrokerSession,
} from "../broker-lifecycle.mts";
import type { TeardownBrokerSessionResult } from "../broker-lifecycle.mts";
import { isRecord } from "../objects.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import type { ParsedArgs } from "../args.mts";
import type { CliResult } from "./job-record-errors.mts";

interface BrokerRow {
  jobId: string;
  profile: string | null;
  host: string | null;
  hostSessionId: string | null;
  pid: number | null;
  status: "running" | "stale" | "malformed";
  endpoint: string | null;
  startedAt: string | null;
  brokerFile: string;
}

interface CleanedBrokerRow extends BrokerRow {
  cleanup: TeardownBrokerSessionResult["teardown"] | "removed";
}

interface BrokersDeps {
  resolveWorkspaceRoot?: (startPath?: string) => Promise<string>;
  brokersDir?: (workspaceRoot: string) => string;
  pidAlive?: (pid: number) => Promise<boolean>;
  cleanupBrokerFiles?: (brokerFile: string, pidFile: string) => Promise<void>;
  teardownBrokerSession?: (args: {
    workspaceRoot: string;
    jobId: string;
    host: string | null;
    hostSessionId: string | null;
    profile: string | null;
  }) => Promise<TeardownBrokerSessionResult>;
}

interface RunBrokersOptions {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: BrokersDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult> {
  return runBrokers({ args: parsedArgs });
}

export async function runBrokers({ args, deps = {} }: RunBrokersOptions): Promise<CliResult> {
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const brokers = await listBrokerRows(workspaceRoot, deps);
  const jobId = args.positional?.[0];
  const selected = jobId ? brokers.filter((broker) => broker.jobId === jobId) : brokers;

  if (jobId && selected.length === 0) {
    return { exitCode: 2, stdout: "", stderr: `broker not found for job: ${jobId}\n` };
  }

  if (args.flags?.cleanup) {
    const cleaned = await cleanupBrokers({
      workspaceRoot,
      brokers: selected,
      cleanupLive: Boolean(jobId),
      deps,
    });
    return {
      exitCode: 0,
      stdout: args.flags?.json
        ? `${JSON.stringify(cleaned)}\n`
        : renderCleanup(cleaned, Boolean(jobId)),
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: args.flags?.json ? `${JSON.stringify(selected)}\n` : renderBrokerTable(selected),
    stderr: "",
  };
}

async function listBrokerRows(workspaceRoot: string, deps: BrokersDeps): Promise<BrokerRow[]> {
  const brokersDir = deps.brokersDir ?? defaultBrokersDir;
  let entries: string[];
  try {
    entries = await fs.readdir(brokersDir(workspaceRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rows: BrokerRow[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    rows.push(await readBrokerRow(path.join(brokersDir(workspaceRoot), entry), deps));
  }
  return rows;
}

async function readBrokerRow(filePath: string, deps: BrokersDeps): Promise<BrokerRow> {
  let state: unknown;
  try {
    state = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return malformedBrokerRow(filePath);
    }
    throw error;
  }

  if (!isRecord(state)) {
    return malformedBrokerRow(filePath);
  }

  const pid = Number.isInteger(state.pid) ? (state.pid as number) : null;
  const running = pid ? await (deps.pidAlive ?? defaultPidAlive)(pid) : false;
  return {
    jobId: typeof state.jobId === "string" ? state.jobId : jobIdFromFile(filePath),
    profile: typeof state.profile === "string" ? state.profile : null,
    host: typeof state.host === "string" ? state.host : null,
    hostSessionId: typeof state.hostSessionId === "string" ? state.hostSessionId : null,
    pid,
    status: running ? "running" : "stale",
    endpoint: typeof state.endpoint === "string" ? state.endpoint : null,
    startedAt: typeof state.startedAt === "string" ? state.startedAt : null,
    brokerFile: filePath,
  };
}

async function cleanupBrokers({
  workspaceRoot,
  brokers,
  cleanupLive,
  deps,
}: {
  workspaceRoot: string;
  brokers: BrokerRow[];
  cleanupLive: boolean;
  deps: BrokersDeps;
}): Promise<CleanedBrokerRow[]> {
  const cleaned: CleanedBrokerRow[] = [];
  const cleanupBrokerFiles = deps.cleanupBrokerFiles ?? defaultCleanupBrokerFiles;
  const teardownBrokerSession = deps.teardownBrokerSession ?? defaultTeardownBrokerSession;

  for (const broker of brokers) {
    if (broker.status === "running" && cleanupLive) {
      const result = await teardownBrokerSession({
        workspaceRoot,
        jobId: broker.jobId,
        host: broker.host,
        hostSessionId: broker.hostSessionId,
        profile: broker.profile,
      });
      cleaned.push({ ...broker, cleanup: result.teardown });
      continue;
    }
    if (broker.status === "running") {
      continue;
    }
    await cleanupBrokerFiles(broker.brokerFile, brokerPidFilePath(broker.brokerFile));
    cleaned.push({ ...broker, cleanup: "removed" });
  }
  return cleaned;
}

function renderBrokerTable(brokers: BrokerRow[]): string {
  const lines = ["jobId\tprofile\tstatus\tpid\thost\thostSessionId\tstartedAt\tbrokerFile"];
  if (brokers.length === 0) {
    lines.push("(no brokers)");
  } else {
    for (const broker of brokers) {
      lines.push(
        [
          broker.jobId,
          broker.profile ?? "-",
          broker.status,
          broker.pid ?? "-",
          broker.host ?? "-",
          broker.hostSessionId ?? "-",
          broker.startedAt ?? "-",
          broker.brokerFile,
        ].join("\t"),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderCleanup(cleaned: CleanedBrokerRow[], targeted: boolean): string {
  if (cleaned.length === 0) {
    return targeted ? "no cleanup needed\n" : "no stale brokers found\n";
  }
  const lines = ["jobId\tstatus\tcleanup\tbrokerFile"];
  for (const broker of cleaned) {
    lines.push([broker.jobId, broker.status, broker.cleanup, broker.brokerFile].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function malformedBrokerRow(filePath: string): BrokerRow {
  return {
    jobId: jobIdFromFile(filePath),
    profile: null,
    host: null,
    hostSessionId: null,
    pid: null,
    status: "malformed",
    endpoint: null,
    startedAt: null,
    brokerFile: filePath,
  };
}

function jobIdFromFile(filePath: string): string {
  return path.basename(filePath, ".json");
}
