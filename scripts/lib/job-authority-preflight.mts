import {
  jobAuthorityFromRecord,
  validateJobAuthority,
  type JobAuthority,
  type JobAuthorityDiagnostic,
} from "./job-authority.mts";

export interface JobAuthorityPreflightInput {
  authority: JobAuthority;
  parentJob?: unknown;
  platform?: NodeJS.Platform;
  workspaceRoot: string;
  profile: string;
}

export type JobAuthorityPreflightResult =
  | { ok: true; authority: JobAuthority }
  | { ok: false; diagnostic: JobAuthorityDiagnostic };

export interface JobAuthorityPreflightDeps {
  probeConfined?: (
    input: JobAuthorityPreflightInput,
  ) => Promise<JobAuthorityPreflightResult>;
}

export async function preflightJobAuthority(
  input: JobAuthorityPreflightInput,
  deps: JobAuthorityPreflightDeps = {},
): Promise<JobAuthorityPreflightResult> {
  const requested = validateJobAuthority(input.authority);
  if (!requested.ok) {
    return requested;
  }
  const authority = requested.authority;

  if ((input.platform ?? process.platform) === "win32") {
    return failure(
      "AUTHORITY_PLATFORM_UNSUPPORTED",
      "native Windows does not support Consult Job Authority confinement or inheritance",
      "Run Consult on native Linux, WSL2, or macOS.",
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

  if (authority.confinement === "inherit") {
    return { ok: true, authority };
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

function failure(
  code: JobAuthorityDiagnostic["code"],
  message: string,
  remediation: string,
): JobAuthorityPreflightResult {
  return { ok: false, diagnostic: { code, message, remediation } };
}
