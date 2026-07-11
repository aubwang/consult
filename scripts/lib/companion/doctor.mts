import fs from "node:fs/promises";
import path from "node:path";

import {
  boolFlag,
  missingFlagValueError,
  stringFlag,
  unsupportedFlagError,
} from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { brokersDir, profilesPath } from "../broker-endpoint.mts";
import { pidAlive as defaultPidAlive } from "../broker-lifecycle.mts";
import { resolveHostIdentity } from "../host-identity.mts";
import { DEFAULT_JOB_AUTHORITY, resolveJobAuthority } from "../job-authority.mts";
import type { JobAuthority, JobAuthorityDiagnostic } from "../job-authority.mts";
import { isFinalStatus, listWorkspaceJobRecords } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";
import { isRecord } from "../objects.mts";
import { resolveWorkspaceRoot as defaultResolveWorkspaceRoot } from "../workspace.mts";
import { probeConfinedSandboxRuntime } from "../sandbox-runtime-launch.mts";
import {
  preflightJobAuthority,
  probeInheritedProfileLaunch,
} from "../job-authority-preflight.mts";
import { resolveInvocationContext } from "./invocation-context.mts";
import type {
  InvocationContext,
  ResolveInvocationContextDeps,
} from "./invocation-context.mts";
import type { CliResult, CodedError } from "./job-record-errors.mts";

export interface DoctorDeps extends ResolveInvocationContextDeps {
  brokersDir?: (workspaceRoot: string) => string;
  listWorkspaceJobRecords?: (workspaceRoot: string) => Promise<JobRecord[]>;
  pidAlive?: (pid: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  probeConfined?: typeof probeConfinedSandboxRuntime;
  probeInherited?: typeof probeInheritedProfileLaunch;
  resolveWorkspaceRoot?: () => Promise<string>;
}

export interface DoctorReport {
  workspaceRoot: string;
  canDelegate: boolean;
  profile: ProfileDoctorReport;
  jobs: JobSummaryReport;
  brokers: BrokerSummaryReport;
  authority: JobAuthorityDoctorReport;
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

interface JobAuthorityDoctorReport {
  ok: boolean;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  defaultAuthority: JobAuthority;
  requestedAuthority: JobAuthority | null;
  requested: {
    ok: boolean;
    diagnostic: JobAuthorityDiagnostic | null;
  };
  selectedProfile: string | null;
  profileRegistryId: string | null;
  confined: {
    ok: boolean;
    diagnostic: JobAuthorityDiagnostic | null;
  };
  inherit: {
    available: boolean;
    explicitFlag: "--sandbox inherit";
    warning: string;
  };
  legacySandboxEnv: string | null;
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
  const unsupported = unsupportedFlagError(args.flags, [
    "agent", "profile", "host", "host-session", "host-session-id", "read-only",
    "write", "isolated", "sandbox", "allow-fetch", "allow-exec", "json",
  ]);
  if (unsupported) {
    return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  }
  const usageError = missingFlagValueError(args.flags, [
    "agent",
    "profile",
    "host",
    "host-session",
    "host-session-id",
    "sandbox",
  ]);
  if (usageError) {
    return { exitCode: 2, stdout: "", stderr: `${usageError}\n` };
  }
  const workspaceRoot = await (deps.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot)();
  const [profile, jobs, brokers, authority] = await Promise.all([
    inspectProfile({ args, env, deps, workspaceRoot }),
    inspectJobs(workspaceRoot, deps),
    inspectBrokers(workspaceRoot, deps),
    inspectAuthority({ args, env, deps, workspaceRoot }),
  ]);
  const report: DoctorReport = {
    workspaceRoot,
    canDelegate: profile.ok && jobs.ok && brokers.ok && authority.ok,
    profile,
    jobs,
    brokers,
    authority,
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

async function inspectAuthority({
  args,
  env,
  deps,
  workspaceRoot,
}: {
  args: ParsedArgs;
  env: Record<string, string | undefined>;
  deps: DoctorDeps;
  workspaceRoot: string;
}): Promise<JobAuthorityDoctorReport> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const inheritAvailable =
    platform === "linux" || (platform === "darwin" && arch === "arm64");
  const base = {
    platform,
    arch,
    defaultAuthority: { ...DEFAULT_JOB_AUTHORITY },
    requestedAuthority: null,
    requested: {
      ok: false,
      diagnostic: null,
    },
    inherit: {
      available: inheritAvailable,
      explicitFlag: "--sandbox inherit" as const,
      warning:
        "explicit inheritance adds no Consult OS boundary and should be chosen only by the trusted Host",
    },
    legacySandboxEnv: env.CONSULT_AGENT_SANDBOX ?? null,
  };
  try {
    const context = await resolveInvocationContext({
      args,
      env,
      deps: {
        ...deps,
        resolveWorkspaceRoot: async () => workspaceRoot,
      },
    });
    const selectedProfile = context.selected.profile ?? null;
    const profileEntry = context.selected.profileEntry;
    if (context.selected.error || !selectedProfile || !profileEntry) {
      return authorityFailure(
        base,
        selectedProfile,
        profileEntry?.registryId ?? null,
        {
          code: "AUTHORITY_COMBINATION_UNSUPPORTED",
          message: context.selected.error ?? "no Profile is available for confined preflight",
          remediation: "Run consult setup and select a configured Profile.",
        },
      );
    }
    const readOnly = boolFlag(args.flags?.["read-only"]);
    const write = boolFlag(args.flags?.write);
    if (readOnly && write) {
      return authorityFailure(base, selectedProfile, profileEntry.registryId, {
        code: "AUTHORITY_INVALID",
        reason: "unknown-mode",
        message: "--read-only and --write are mutually exclusive",
        remediation: "Choose exactly one mode.",
      });
    }
    const resolved = resolveJobAuthority({
      mode: write ? "write" : "read-only",
      confinement: stringFlag(args.flags?.sandbox),
      allowFetch: boolFlag(args.flags?.["allow-fetch"]),
      allowExecute: boolFlag(args.flags?.["allow-exec"]),
      isolated: boolFlag(args.flags?.isolated),
    });
    if (!resolved.ok) {
      return authorityFailure(
        { ...base, requested: { ok: false, diagnostic: resolved.diagnostic } },
        selectedProfile,
        profileEntry.registryId,
        resolved.diagnostic,
      );
    }
    const requestedAuthority = resolved.authority;
    const requested = await preflightJobAuthority({
      authority: requestedAuthority,
      platform,
      arch,
      workspaceRoot,
      profile: selectedProfile,
      profileRegistryId: profileEntry.registryId,
      profileLaunch: {
        binary: profileEntry.binary,
        args: profileEntry.args,
        env: profileEntry.env,
      },
    }, {
      probeConfined: deps.probeConfined ?? probeConfinedSandboxRuntime,
      probeInherited: deps.probeInherited ?? probeInheritedProfileLaunch,
    });
    const confined = requestedAuthority.confinement === "confined"
      ? requested
      : await (deps.probeConfined ?? probeConfinedSandboxRuntime)({
      authority: { ...DEFAULT_JOB_AUTHORITY },
      platform,
      arch,
      workspaceRoot,
      profile: selectedProfile,
      profileRegistryId: profileEntry.registryId,
      profileLaunch: {
        binary: profileEntry.binary,
        args: profileEntry.args,
        env: profileEntry.env,
      },
        });
    return {
      ...base,
      ok: requested.ok,
      requestedAuthority,
      requested: {
        ok: requested.ok,
        diagnostic: requested.ok ? null : requested.diagnostic,
      },
      selectedProfile,
      profileRegistryId: profileEntry.registryId,
      confined: {
        ok: confined.ok,
        diagnostic: confined.ok ? null : confined.diagnostic,
      },
    };
  } catch (error) {
    return authorityFailure(base, null, null, {
      code: "AUTHORITY_PREFLIGHT_FAILED",
      message: describeCodedError(error),
      remediation: "Fix Profile setup or use explicit inheritance only if ambient authority is acceptable.",
    });
  }
}

function authorityFailure(
  base: Pick<
    JobAuthorityDoctorReport,
    | "platform"
    | "arch"
    | "defaultAuthority"
    | "requestedAuthority"
    | "requested"
    | "inherit"
    | "legacySandboxEnv"
  >,
  selectedProfile: string | null,
  profileRegistryId: string | null,
  diagnostic: JobAuthorityDiagnostic,
): JobAuthorityDoctorReport {
  return {
    ...base,
    ok: false,
    requested: {
      ok: false,
      diagnostic: base.requested.diagnostic ?? diagnostic,
    },
    selectedProfile,
    profileRegistryId,
    confined: { ok: false, diagnostic },
  };
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
    "job authority:",
    `  requested: ${report.authority.requested.ok ? "ready" : `unready: ${report.authority.requested.diagnostic?.message}`}`,
    `  requested mode: ${report.authority.requestedAuthority?.mode ?? "-"}`,
    `  requested confinement: ${report.authority.requestedAuthority?.confinement ?? "-"}`,
    `  requested fetch: ${yesNo(report.authority.requestedAuthority?.allowFetch ?? false)}`,
    `  default confined: ${report.authority.confined.ok ? "ready" : `unready: ${report.authority.confined.diagnostic?.message}`}`,
    `  platform: ${report.authority.platform}`,
    `  profile: ${valueOrDash(report.authority.selectedProfile)}`,
    `  registry identity: ${valueOrDash(report.authority.profileRegistryId)}`,
    `  default mode: ${report.authority.defaultAuthority.mode}`,
    `  fetch: ${yesNo(report.authority.defaultAuthority.allowFetch)}`,
    `  execute: ${yesNo(report.authority.defaultAuthority.allowExecute)}`,
    `  explicit inherit available: ${yesNo(report.authority.inherit.available)}`,
    `  inherit warning: ${report.authority.inherit.warning}`,
    `  legacy CONSULT_AGENT_SANDBOX: ${valueOrDash(report.authority.legacySandboxEnv)}`,
  ].join("\n")}\n`;
}

function valueOrDash(value: string | number | null): string {
  return value === null ? "-" : String(value);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
