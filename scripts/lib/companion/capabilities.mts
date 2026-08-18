import { boolFlag, invalidBooleanFlagValueError, unsupportedFlagError } from "../args.mts";
import type { ParsedArgs } from "../args.mts";
import { JOB_RESULT_SCHEMA_VERSION } from "../job-result-contract.mts";
import {
  MAX_REPORTS_PER_JOB,
  MAX_REPORT_DATA_BYTES,
  MAX_REPORT_MESSAGE_BYTES,
} from "../job-reports.mts";
import { MAX_STEER_GUIDANCE_BYTES } from "../job-steer.mts";
import { PROFILES_SCHEMA_VERSION } from "../profiles.mts";
import { loadRegistry as defaultLoadRegistry } from "../registry.mts";
import type { Registry } from "../registry.mts";
import { EVENTS_SCHEMA_VERSION } from "./events.mts";
import type { CliResult, CodedError } from "./job-record-errors.mts";
import { registryErrorResult } from "./registry-errors.mts";
import { resolvePackageVersion } from "./version.mts";

// Hosts used to discover optional commands by running them and reading the exit
// code, which cannot distinguish "this build has no such command" from "the
// arguments were wrong". Capabilities is the versioned answer to that question,
// and like help and version it is a static self-description: it reads no
// Workspace, no Job state, and no configured Profiles, so it answers the same
// way from anywhere on the filesystem.
export const CAPABILITIES_SCHEMA_VERSION = 1;

export interface CapabilitiesReport {
  schemaVersion: number;
  version: string;
  contracts: {
    jobResult: number;
    events: number;
    profiles: number;
  };
  features: {
    report: boolean;
    events: boolean;
    steer: boolean;
    reportExec: boolean;
    nativeReviewProfiles: string[];
  };
  bounds: {
    reportMessageBytes: number;
    reportDataBytes: number;
    reportsPerJob: number;
    steerGuidanceBytes: number;
  };
}

export interface CapabilitiesDeps {
  loadRegistry?: () => Promise<Registry>;
  version?: () => string;
}

export interface RunCapabilitiesOptions {
  args: ParsedArgs;
  deps?: CapabilitiesDeps;
}

export async function run(_subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult> {
  return runCapabilities({ args: parsedArgs });
}

export async function runCapabilities({
  args,
  deps = {},
}: RunCapabilitiesOptions): Promise<CliResult> {
  const unsupported = unsupportedFlagError(args.flags, ["json"]);
  if (unsupported) {
    return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  }
  const invalidBoolean = invalidBooleanFlagValueError(args.flags);
  if (invalidBoolean) {
    return { exitCode: 2, stdout: "", stderr: `${invalidBoolean}\n` };
  }
  const positional = args.positional ?? [];
  if (positional.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unexpected argument: ${positional[0]}\n`,
    };
  }
  let registry: Registry;
  try {
    registry = await (deps.loadRegistry ?? defaultLoadRegistry)();
  } catch (error) {
    const registryResult = registryErrorResult(error as CodedError);
    if (registryResult) {
      return registryResult;
    }
    throw error;
  }
  const report = capabilitiesReport(registry, deps.version ?? resolvePackageVersion);
  return {
    exitCode: 0,
    stdout: boolFlag(args.flags?.json) ? `${JSON.stringify(report)}\n` : renderReport(report),
    stderr: "",
  };
}

// Every number here is the constant the behavior itself is bounded by, never a
// restatement of it: a bound that moves without this report moving would be
// worse than no report at all.
export function capabilitiesReport(
  registry: Registry,
  version: () => string,
): CapabilitiesReport {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    version: version(),
    contracts: {
      jobResult: JOB_RESULT_SCHEMA_VERSION,
      events: EVENTS_SCHEMA_VERSION,
      profiles: PROFILES_SCHEMA_VERSION,
    },
    features: {
      report: true,
      events: true,
      steer: true,
      // An inherit-sandbox Job can run `consult report` itself: the permission
      // layer approves that one execute without an execute grant (ADR-0042).
      reportExec: true,
      nativeReviewProfiles: registry.agents
        .filter((agent) => agent.advertisesReview === true)
        .map((agent) => agent.id),
    },
    bounds: {
      reportMessageBytes: MAX_REPORT_MESSAGE_BYTES,
      reportDataBytes: MAX_REPORT_DATA_BYTES,
      reportsPerJob: MAX_REPORTS_PER_JOB,
      steerGuidanceBytes: MAX_STEER_GUIDANCE_BYTES,
    },
  };
}

function renderReport(report: CapabilitiesReport): string {
  const nativeReview = report.features.nativeReviewProfiles;
  return [
    `consult ${report.version}`,
    "",
    "contract\tversion",
    `jobResult\t${report.contracts.jobResult}`,
    `events\t${report.contracts.events}`,
    `profiles\t${report.contracts.profiles}`,
    "",
    "feature\tavailable",
    `report\t${yesNo(report.features.report)}`,
    `events\t${yesNo(report.features.events)}`,
    `steer\t${yesNo(report.features.steer)}`,
    `reportExec\t${yesNo(report.features.reportExec)}`,
    `nativeReview\t${nativeReview.length > 0 ? nativeReview.join(", ") : "(none)"}`,
    "",
    "bound\tvalue",
    `reportMessageBytes\t${report.bounds.reportMessageBytes}`,
    `reportDataBytes\t${report.bounds.reportDataBytes}`,
    `reportsPerJob\t${report.bounds.reportsPerJob}`,
    `steerGuidanceBytes\t${report.bounds.steerGuidanceBytes}`,
    "",
  ].join("\n");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
