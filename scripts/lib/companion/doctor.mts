import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { missingFlagValueError } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { brokersDir, profilesPath } from "../broker-endpoint.mts";
import { pidAlive as defaultPidAlive } from "../broker-lifecycle.mts";
import { resolveHostIdentity } from "../host-identity.mts";
import { isFinalStatus, listWorkspaceJobRecords } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { isRecord } from "../objects.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { resolveInvocationContext } from "./invocation-context.mts";
import type {
  InvocationContext,
  ResolveInvocationContextDeps,
} from "./invocation-context.mts";
import type { CliResult, CodedError } from "./job-record-errors.mts";

export interface DoctorDeps extends ResolveInvocationContextDeps {
  brokersDir?: (workspaceRoot: string) => string;
  commandExists?: (command: string, env: Record<string, string | undefined>) => Promise<boolean>;
  listWorkspaceJobRecords?: (workspaceRoot: string) => Promise<JobRecord[]>;
  pidAlive?: (pid: number) => Promise<boolean>;
  resolveWorkspaceRoot?: () => Promise<string>;
}

export interface DoctorReport {
  workspaceRoot: string;
  canDelegate: boolean;
  profile: ProfileDoctorReport;
  jobs: JobSummaryReport;
  brokers: BrokerSummaryReport;
  sandbox: SandboxReport;
}

interface ProfileDoctorReport {
  ok: boolean;
  profilesPath: string;
  host: string;
  hostSessionId: string;
  configuredProfiles: number | null;
  defaultProfile: string | null;
  hostDefaultProfile: string | null;
  selectedProfile: string | null;
  error: string | null;
}

interface JobSummaryReport {
  ok: boolean;
  total: number | null;
  queued: number;
  running: number;
  final: number;
  completed: number;
  cancelled: number;
  failed: number;
  other: number;
  error: string | null;
}

interface BrokerSummaryReport {
  ok: boolean;
  total: number | null;
  running: number;
  stale: number;
  malformed: number;
  error: string | null;
}

interface SandboxReport {
  ok: boolean;
  envValue: string | null;
  mode: "off" | "bwrap" | "unknown";
  bwrapConfigured: boolean;
  bwrapOnPath: boolean;
  error: string | null;
}

interface BrokerSummary {
  total: number;
  running: number;
  stale: number;
  malformed: number;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult> {
  return runDoctor({ args: parsedArgs });
}

export async function runDoctor({
  args,
  env = process.env,
  deps = {},
}: {
  args: ParsedArgs;
  env?: Record<string, string | undefined>;
  deps?: DoctorDeps;
}): Promise<CliResult> {
  const usageError = missingFlagValueError(args.flags, [
    "agent",
    "profile",
    "host",
    "host-session",
    "host-session-id",
  ]);
  if (usageError) {
    return { exitCode: 2, stdout: "", stderr: `${usageError}\n` };
  }
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const [profile, jobs, brokers, sandbox] = await Promise.all([
    inspectProfile({ args, env, deps, workspaceRoot }),
    inspectJobs(workspaceRoot, deps),
    inspectBrokers(workspaceRoot, deps),
    inspectSandbox(env, deps),
  ]);
  const report: DoctorReport = {
    workspaceRoot,
    canDelegate: profile.ok && jobs.ok && brokers.ok && sandbox.ok,
    profile,
    jobs,
    brokers,
    sandbox,
  };

  // Exit 1 when the workspace is not delegate-ready so scripted callers can
  // gate on `consult doctor` without parsing the report.
  return {
    exitCode: report.canDelegate ? 0 : 1,
    stdout: args.flags?.json ? `${JSON.stringify(report)}\n` : renderDoctor(report),
    stderr: "",
  };
}

async function inspectProfile({
  args,
  env,
  deps,
  workspaceRoot,
}: {
  args: ParsedArgs;
  env: Record<string, string | undefined>;
  deps: DoctorDeps;
  workspaceRoot: string;
}): Promise<ProfileDoctorReport> {
  try {
    const context = await resolveInvocationContext({
      args,
      env,
      deps: {
        ...deps,
        resolveWorkspaceRoot: async () => workspaceRoot,
      },
    });
    return profileReportFromContext(context);
  } catch (error) {
    const hostIdentity = resolveHostIdentity({ args, env });
    return {
      ok: false,
      profilesPath: profilesPath(),
      host: hostIdentity.host,
      hostSessionId: hostIdentity.hostSessionId,
      configuredProfiles: null,
      defaultProfile: null,
      hostDefaultProfile: null,
      selectedProfile: null,
      error: describeCodedError(error),
    };
  }
}

function profileReportFromContext(context: InvocationContext): ProfileDoctorReport {
  const hostDefaultProfile = context.profiles.hostDefaults?.[context.hostIdentity.host] ?? null;
  return {
    ok: !context.selected.error,
    profilesPath: profilesPath(),
    host: context.hostIdentity.host,
    hostSessionId: context.hostIdentity.hostSessionId,
    configuredProfiles: Object.keys(context.profiles.profiles).length,
    defaultProfile: context.profiles.default,
    hostDefaultProfile,
    selectedProfile: context.selected.profile ?? null,
    error: context.selected.error ?? null,
  };
}

async function inspectJobs(
  workspaceRoot: string,
  deps: DoctorDeps,
): Promise<JobSummaryReport> {
  try {
    const records = await (deps.listWorkspaceJobRecords ?? listWorkspaceJobRecords)(workspaceRoot);
    return {
      ok: true,
      total: records.length,
      queued: countJobs(records, "queued"),
      running: countJobs(records, "running"),
      final: records.filter((record) => isFinalStatus(record.status)).length,
      completed: countJobs(records, "completed"),
      cancelled: countJobs(records, "cancelled"),
      failed: countJobs(records, "failed"),
      other: records.filter((record) => !knownJobStatus(record.status)).length,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      total: null,
      queued: 0,
      running: 0,
      final: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      other: 0,
      error: describeCodedError(error),
    };
  }
}

async function inspectBrokers(
  workspaceRoot: string,
  deps: DoctorDeps,
): Promise<BrokerSummaryReport> {
  try {
    const summary = await readBrokerSummary(workspaceRoot, deps);
    return { ok: true, ...summary, error: null };
  } catch (error) {
    return {
      ok: false,
      total: null,
      running: 0,
      stale: 0,
      malformed: 0,
      error: describeCodedError(error),
    };
  }
}

async function readBrokerSummary(
  workspaceRoot: string,
  deps: DoctorDeps,
): Promise<BrokerSummary> {
  let entries: string[];
  const brokerDir = (deps.brokersDir ?? brokersDir)(workspaceRoot);
  try {
    entries = await fs.readdir(brokerDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { total: 0, running: 0, stale: 0, malformed: 0 };
    }
    throw error;
  }

  const summary = { total: 0, running: 0, stale: 0, malformed: 0 };
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    summary.total += 1;
    const status = await readBrokerStatus(path.join(brokerDir, entry), deps);
    summary[status] += 1;
  }
  return summary;
}

async function readBrokerStatus(
  brokerFile: string,
  deps: DoctorDeps,
): Promise<"running" | "stale" | "malformed"> {
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(brokerFile, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return "malformed";
    }
    throw error;
  }
  if (!isRecord(data) || !Number.isInteger(data.pid)) {
    return "malformed";
  }
  return (await (deps.pidAlive ?? defaultPidAlive)(data.pid as number)) ? "running" : "stale";
}

async function inspectSandbox(
  env: Record<string, string | undefined>,
  deps: DoctorDeps,
): Promise<SandboxReport> {
  const envValue = env.CONSULT_AGENT_SANDBOX ?? null;
  const mode = sandboxMode(envValue);
  const bwrapOnPath = await (deps.commandExists ?? commandExists)("bwrap", env);
  const error =
    mode === "unknown"
      ? `unknown CONSULT_AGENT_SANDBOX: ${envValue}`
      : mode === "bwrap" && !bwrapOnPath
        ? "CONSULT_AGENT_SANDBOX=bwrap but bwrap was not found on PATH"
        : null;
  return {
    ok: error === null,
    envValue,
    mode,
    bwrapConfigured: envValue === "bwrap",
    bwrapOnPath,
    error,
  };
}

async function commandExists(
  command: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      await fs.access(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

function sandboxMode(value: string | null): SandboxReport["mode"] {
  if (value === null || value === "" || value === "0" || value === "false" || value === "off") {
    return "off";
  }
  if (value === "1" || value === "true" || value === "bwrap") {
    return "bwrap";
  }
  return "unknown";
}

function countJobs(records: JobRecord[], status: string): number {
  return records.filter((record) => record.status === status).length;
}

function knownJobStatus(status: unknown): boolean {
  return ["queued", "running", "completed", "cancelled", "failed"].includes(status as string);
}

function describeCodedError(error: unknown): string {
  const coded = error as CodedError;
  if (coded.path) {
    return `${coded.code ?? "ERROR"}: ${coded.path}`;
  }
  return (error as Error).message ?? String(error);
}

function renderDoctor(report: DoctorReport): string {
  return `${[
    "Consult doctor",
    `workspace: ${report.workspaceRoot}`,
    `canDelegate: ${yesNo(report.canDelegate)}`,
    "",
    "profile/setup:",
    `  status: ${report.profile.ok ? "ok" : `error: ${report.profile.error}`}`,
    `  host: ${report.profile.host}`,
    `  hostSessionId: ${report.profile.hostSessionId}`,
    `  profiles: ${valueOrDash(report.profile.configuredProfiles)}`,
    `  default: ${valueOrDash(report.profile.defaultProfile)}`,
    `  hostDefault: ${valueOrDash(report.profile.hostDefaultProfile)}`,
    `  selected: ${valueOrDash(report.profile.selectedProfile)}`,
    "",
    "jobs:",
    `  status: ${report.jobs.ok ? "ok" : `error: ${report.jobs.error}`}`,
    `  total: ${valueOrDash(report.jobs.total)}`,
    `  queued: ${report.jobs.queued}`,
    `  running: ${report.jobs.running}`,
    `  final: ${report.jobs.final}`,
    `  completed: ${report.jobs.completed}`,
    `  cancelled: ${report.jobs.cancelled}`,
    `  failed: ${report.jobs.failed}`,
    `  other: ${report.jobs.other}`,
    "",
    "brokers:",
    `  status: ${report.brokers.ok ? "ok" : `error: ${report.brokers.error}`}`,
    `  total: ${valueOrDash(report.brokers.total)}`,
    `  running: ${report.brokers.running}`,
    `  stale: ${report.brokers.stale}`,
    `  malformed: ${report.brokers.malformed}`,
    "",
    "sandbox:",
    `  status: ${report.sandbox.ok ? "ok" : `error: ${report.sandbox.error}`}`,
    `  CONSULT_AGENT_SANDBOX: ${valueOrDash(report.sandbox.envValue)}`,
    `  mode: ${report.sandbox.mode}`,
    `  bwrap configured: ${yesNo(report.sandbox.bwrapConfigured)}`,
    `  bwrap on PATH: ${yesNo(report.sandbox.bwrapOnPath)}`,
  ].join("\n")}\n`;
}

function valueOrDash(value: string | number | null): string {
  return value === null ? "-" : String(value);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
