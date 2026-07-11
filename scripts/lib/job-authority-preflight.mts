import {
  jobAuthorityFromRecord,
  validateJobAuthority,
  type JobAuthority,
  type JobAuthorityDiagnostic,
} from "./job-authority.mts";
import { startAgent } from "./acp-client.mts";

export interface JobAuthorityPreflightInput {
  authority: JobAuthority;
  parentJob?: unknown;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  workspaceRoot: string;
  /** Built-in Profile identity; configured aliases remain user-facing `profile`. */
  profileRegistryId?: string;
  profile: string;
  /** Exact configured Profile launch checked before a confined Job is persisted. */
  profileLaunch?: {
    binary: string;
    args: string[];
    env: Record<string, string>;
  };
}

export type JobAuthorityPreflightResult =
  | { ok: true; authority: JobAuthority }
  | { ok: false; diagnostic: JobAuthorityDiagnostic };

export interface JobAuthorityPreflightDeps {
  probeInherited?: (
    input: JobAuthorityPreflightInput,
  ) => Promise<JobAuthorityPreflightResult>;
  probeConfined?: (
    input: JobAuthorityPreflightInput,
  ) => Promise<JobAuthorityPreflightResult>;
}

export interface JobAuthorityRuntimeBoundaryInput {
  authority: JobAuthority;
  parentJob?: unknown;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

export function validateJobAuthorityRuntimeBoundary(
  input: JobAuthorityRuntimeBoundaryInput,
): JobAuthorityPreflightResult {
  const requested = validateJobAuthority(input.authority);
  if (!requested.ok) {
    return requested;
  }
  const authority = requested.authority;

  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (
    (platform !== "linux" && platform !== "darwin") ||
    (platform === "darwin" && arch !== "arm64")
  ) {
    return failure(
      "AUTHORITY_PLATFORM_UNSUPPORTED",
      platform === "darwin"
        ? `macOS ${arch} processes do not support Consult Job Authority confinement or inheritance`
        : `${platform === "win32" ? "native Windows" : platform} does not support Consult Job Authority confinement or inheritance`,
      "Run Consult on native Linux, WSL2, or macOS with a native arm64 Node process.",
    );
  }

  if (authority.allowExecute) {
    return failure(
      "AUTHORITY_EXECUTE_UNAVAILABLE",
      "execute authority is unavailable at the runtime launch boundary",
      "Recreate the Job without execute authority.",
    );
  }

  if (input.parentJob !== undefined && input.parentJob !== null) {
    const parent = jobAuthorityFromRecord(input.parentJob);
    if (!parent.ok) {
      return parent;
    }
    if (
      authority.confinement === "confined" ||
      parent.authority.confinement === "confined"
    ) {
      return failure(
        "AUTHORITY_NESTED_CONFINED_UNSUPPORTED",
        "confined nested delegation is unsupported",
        "Have the trusted root Host start a sibling Job, or use explicit inheritance only for cooperative ambient chains.",
      );
    }
  }

  return { ok: true, authority };
}

export async function preflightJobAuthority(
  input: JobAuthorityPreflightInput,
  deps: JobAuthorityPreflightDeps = {},
): Promise<JobAuthorityPreflightResult> {
  const boundary = validateJobAuthorityRuntimeBoundary(input);
  if (!boundary.ok) return boundary;
  const authority = boundary.authority;

  if (authority.confinement === "inherit") {
    if (!deps.probeInherited) {
      return failure(
        "AUTHORITY_COMBINATION_UNSUPPORTED",
        `inherited authority preflight requires the exact '${input.profile}' Profile launch`,
        "Re-run Consult setup for this Profile and retry; no Job was created.",
      );
    }
    try {
      return await deps.probeInherited({ ...input, authority });
    } catch (error) {
      return failure(
        "AUTHORITY_PREFLIGHT_FAILED",
        `inherited authority preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        "Run consult doctor for the inherited Profile launch and fix its ACP initialization; no Job was created.",
      );
    }
  }
  if (!deps.probeConfined) {
    return failure(
      "AUTHORITY_COMBINATION_UNSUPPORTED",
      `confined authority is not available for profile '${input.profile}' in this Host context`,
      "Run consult doctor --json for readiness, or retry with --sandbox inherit only if ambient authority is acceptable.",
    );
  }

  try {
    return await deps.probeConfined({ ...input, authority });
  } catch (error) {
    return failure(
      "AUTHORITY_PREFLIGHT_FAILED",
      `confined authority preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      "Run consult doctor --json and fix the reported sandbox dependency or nesting failure; no Job was created.",
    );
  }
}

export async function probeInheritedProfileLaunch(
  input: JobAuthorityPreflightInput,
): Promise<JobAuthorityPreflightResult> {
  if (!input.profileLaunch) {
    return failure(
      "AUTHORITY_COMBINATION_UNSUPPORTED",
      `inherited authority preflight requires the exact '${input.profile}' Profile launch`,
      "Re-run Consult setup for this Profile and retry; no Job was created.",
    );
  }
  let agent: Awaited<ReturnType<typeof startAgent>> | undefined;
  let launchFailure: unknown;
  try {
    agent = await startAgent({
      binary: input.profileLaunch.binary,
      args: input.profileLaunch.args,
      env: input.profileLaunch.env,
      cwd: input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      mode: input.authority.mode,
      sandbox: "off",
      profileRegistryId: input.profileRegistryId,
    });
  } catch (error) {
    launchFailure = error;
  } finally {
    if (agent) {
      try {
        await agent.dispose();
      } catch (error) {
        launchFailure ??= error;
      }
    }
  }
  if (launchFailure !== undefined) {
    return failure(
      "AUTHORITY_PREFLIGHT_FAILED",
      `inherited authority preflight failed: ${launchFailure instanceof Error ? launchFailure.message : String(launchFailure)}`,
      "Run consult doctor for the inherited Profile launch and fix its ACP initialization; no Job was created.",
    );
  }
  return { ok: true, authority: input.authority };
}

function failure(
  code: JobAuthorityDiagnostic["code"],
  message: string,
  remediation: string,
): JobAuthorityPreflightResult {
  return { ok: false, diagnostic: { code, message, remediation } };
}
