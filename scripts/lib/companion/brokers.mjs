import fs from "node:fs/promises";
import path from "node:path";

import { brokersDir as defaultBrokersDir } from "../broker-endpoint.mjs";
import {
  brokerPidFilePath,
  cleanupBrokerFiles as defaultCleanupBrokerFiles,
  pidAlive as defaultPidAlive,
  teardownBrokerSession as defaultTeardownBrokerSession,
} from "../broker-lifecycle.mjs";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mjs";

export async function run(subcommand, parsedArgs) {
  return runBrokers({ args: parsedArgs });
}

export async function runBrokers({ args, deps = {} }) {
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

async function listBrokerRows(workspaceRoot, deps) {
  const brokersDir = deps.brokersDir ?? defaultBrokersDir;
  let entries;
  try {
    entries = await fs.readdir(brokersDir(workspaceRoot));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rows = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    rows.push(await readBrokerRow(path.join(brokersDir(workspaceRoot), entry), deps));
  }
  return rows;
}

async function readBrokerRow(filePath, deps) {
  let state;
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

  const pid = Number.isInteger(state.pid) ? state.pid : null;
  const running = pid ? await (deps.pidAlive ?? defaultPidAlive)(pid) : false;
  return {
    jobId: state.jobId ?? jobIdFromFile(filePath),
    profile: state.profile ?? null,
    host: state.host ?? null,
    hostSessionId: state.hostSessionId ?? null,
    pid,
    status: running ? "running" : "stale",
    endpoint: state.endpoint ?? null,
    startedAt: state.startedAt ?? null,
    brokerFile: filePath,
  };
}

async function cleanupBrokers({ workspaceRoot, brokers, cleanupLive, deps }) {
  const cleaned = [];
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

function renderBrokerTable(brokers) {
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

function renderCleanup(cleaned, targeted) {
  if (cleaned.length === 0) {
    return targeted ? "no cleanup needed\n" : "no stale brokers found\n";
  }
  const lines = ["jobId\tstatus\tcleanup\tbrokerFile"];
  for (const broker of cleaned) {
    lines.push([broker.jobId, broker.status, broker.cleanup, broker.brokerFile].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function malformedBrokerRow(filePath) {
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

function jobIdFromFile(filePath) {
  return path.basename(filePath, ".json");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
