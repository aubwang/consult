export const JOB_AUTHORITY_SCHEMA_VERSION = 1 as const;

export type JobMode = "read-only" | "write";
export type JobConfinement = "confined" | "inherit";

export interface JobAuthority {
  schemaVersion: typeof JOB_AUTHORITY_SCHEMA_VERSION;
  mode: JobMode;
  confinement: JobConfinement;
  allowFetch: boolean;
  allowExecute: boolean;
}

export const DEFAULT_JOB_AUTHORITY: Readonly<JobAuthority> = Object.freeze({
  schemaVersion: JOB_AUTHORITY_SCHEMA_VERSION,
  mode: "read-only",
  confinement: "confined",
  allowFetch: false,
  allowExecute: false,
});

export type JobAuthorityErrorCode =
  | "AUTHORITY_INVALID"
  | "AUTHORITY_PLATFORM_UNSUPPORTED"
  | "AUTHORITY_COMBINATION_UNSUPPORTED"
  | "AUTHORITY_PREFLIGHT_FAILED"
  | "AUTHORITY_NESTED_CONFINED_UNSUPPORTED"
  | "AUTHORITY_EXECUTE_UNAVAILABLE"
  | "AUTHORITY_MISMATCH";

export type JobAuthorityInvalidReason =
  | "malformed-authority"
  | "invalid-schema-version"
  | "unknown-mode"
  | "unknown-confinement"
  | "non-boolean-grant"
  | "non-boolean-isolated"
  | "fetch-requires-confined"
  | "execute-requires-confined"
  | "fetch-execute-conflict"
  | "execute-requires-isolated-write"
  | "legacy-sandbox-conflict";

export interface JobAuthorityDiagnostic {
  code: JobAuthorityErrorCode;
  message: string;
  remediation: string;
  reason?: JobAuthorityInvalidReason;
  details?: Record<string, string | number | boolean | null>;
}

export interface JobAuthoritySuccess {
  ok: true;
  authority: JobAuthority;
}

export interface JobAuthorityFailure {
  ok: false;
  diagnostic: JobAuthorityDiagnostic;
}

export type JobAuthorityResult = JobAuthoritySuccess | JobAuthorityFailure;

export interface ResolveJobAuthorityInput {
  mode?: unknown;
  confinement?: unknown;
  allowFetch?: unknown;
  allowExecute?: unknown;
  /** Execution Workspace topology is validated but is not part of Job Authority. */
  isolated?: unknown;
}

export interface LegacyJobAuthorityRecord {
  authority?: unknown;
  mode?: unknown;
  allowExecute?: unknown;
  [key: string]: unknown;
}

export interface CodedJobAuthorityError extends Error {
  code: JobAuthorityErrorCode;
  diagnostic: JobAuthorityDiagnostic;
}

/**
 * Resolve a trusted Host's requested grant into the canonical portable shape.
 * Platform/Profile availability belongs to the later preflight boundary.
 */
export function resolveJobAuthority(
  input: ResolveJobAuthorityInput = {},
): JobAuthorityResult {
  const mode = input.mode ?? DEFAULT_JOB_AUTHORITY.mode;
  if (!isJobMode(mode)) {
    return invalid(
      "unknown-mode",
      `unknown Job Authority mode: ${String(mode)}`,
      "Use --read-only (the default) or --write.",
    );
  }

  const confinement = input.confinement ?? DEFAULT_JOB_AUTHORITY.confinement;
  if (!isJobConfinement(confinement)) {
    return invalid(
      "unknown-confinement",
      `unknown Job Authority confinement: ${String(confinement)}`,
      "Use --sandbox confined (the default) or --sandbox inherit.",
    );
  }

  const allowFetch = input.allowFetch ?? DEFAULT_JOB_AUTHORITY.allowFetch;
  const allowExecute = input.allowExecute ?? DEFAULT_JOB_AUTHORITY.allowExecute;
  if (typeof allowFetch !== "boolean" || typeof allowExecute !== "boolean") {
    return invalid(
      "non-boolean-grant",
      "Job Authority fetch and execute grants must be boolean",
      "Pass --allow-fetch or --allow-exec as flags rather than values.",
    );
  }

  const isolated = input.isolated ?? false;
  if (typeof isolated !== "boolean") {
    return invalid(
      "non-boolean-isolated",
      "isolated execution selection must be boolean",
      "Pass --isolated as a flag rather than a value.",
    );
  }

  const authority: JobAuthority = {
    schemaVersion: JOB_AUTHORITY_SCHEMA_VERSION,
    mode,
    confinement,
    allowFetch,
    allowExecute,
  };
  const structural = validateComposition(authority);
  if (structural) {
    return structural;
  }
  if (authority.allowExecute && !isolated) {
    return invalid(
      "execute-requires-isolated-write",
      "execute authority requires a write Job with an isolated Execution Workspace",
      "Use --write --isolated with --allow-exec, or remove --allow-exec.",
    );
  }
  if (authority.allowExecute) {
    return failure({
      code: "AUTHORITY_EXECUTE_UNAVAILABLE",
      message:
        "execute authority is unavailable until confined networking and model transport are enforced",
      remediation: "Remove --allow-exec; confined execute authority is not currently available.",
    });
  }
  return success(authority);
}

/**
 * Parse a persisted or protocol authority. This checks the v1 shape and its
 * intrinsic composition, but deliberately does not apply current availability
 * gates so historical and future execute grants remain representable.
 */
export function validateJobAuthority(value: unknown): JobAuthorityResult {
  if (!isRecord(value)) {
    return invalid(
      "malformed-authority",
      "Job Authority must be an object",
      "Provide a canonical versioned Job Authority object.",
    );
  }
  if (value.schemaVersion !== JOB_AUTHORITY_SCHEMA_VERSION) {
    return invalid(
      "invalid-schema-version",
      `unsupported Job Authority schema version: ${String(value.schemaVersion)}`,
      `Use Job Authority schema version ${JOB_AUTHORITY_SCHEMA_VERSION}.`,
    );
  }
  if (!isJobMode(value.mode)) {
    return invalid(
      "unknown-mode",
      `unknown Job Authority mode: ${String(value.mode)}`,
      "Use read-only or write.",
    );
  }
  if (!isJobConfinement(value.confinement)) {
    return invalid(
      "unknown-confinement",
      `unknown Job Authority confinement: ${String(value.confinement)}`,
      "Use confined or inherit.",
    );
  }
  if (typeof value.allowFetch !== "boolean" || typeof value.allowExecute !== "boolean") {
    return invalid(
      "non-boolean-grant",
      "Job Authority fetch and execute grants must be boolean",
      "Provide literal boolean allowFetch and allowExecute fields.",
    );
  }

  const authority: JobAuthority = {
    schemaVersion: JOB_AUTHORITY_SCHEMA_VERSION,
    mode: value.mode,
    confinement: value.confinement,
    allowFetch: value.allowFetch,
    allowExecute: value.allowExecute,
  };
  return validateComposition(authority) ?? success(authority);
}

/**
 * Old Job records predate explicit confinement and therefore describe ambient
 * inheritance, never the new confined default.
 */
export function projectLegacyJobAuthority(record: unknown): JobAuthority {
  const legacy = isRecord(record) ? record : {};
  return {
    schemaVersion: JOB_AUTHORITY_SCHEMA_VERSION,
    mode: legacy.mode === "write" ? "write" : "read-only",
    confinement: "inherit",
    allowFetch: false,
    allowExecute: legacy.allowExecute === true,
  };
}

export function jobAuthorityFromRecord(record: unknown): JobAuthorityResult {
  if (!isRecord(record)) {
    return invalid(
      "malformed-authority",
      "Job record must be an object",
      "Provide a valid Job record.",
    );
  }
  if (record.authority === undefined) {
    return success(projectLegacyJobAuthority(record));
  }
  return validateJobAuthority(record.authority);
}

export function jobAuthoritiesEqual(left: unknown, right: unknown): boolean {
  const leftResult = validateJobAuthority(left);
  const rightResult = validateJobAuthority(right);
  return (
    leftResult.ok &&
    rightResult.ok &&
    leftResult.authority.mode === rightResult.authority.mode &&
    leftResult.authority.confinement === rightResult.authority.confinement &&
    leftResult.authority.allowFetch === rightResult.authority.allowFetch &&
    leftResult.authority.allowExecute === rightResult.authority.allowExecute
  );
}

export function assertJobAuthority(value: unknown): asserts value is JobAuthority {
  const result = validateJobAuthority(value);
  if (!result.ok) {
    throw diagnosticError(result.diagnostic);
  }
}

export function assertMatchingJobAuthority(actual: unknown, expected: unknown): void {
  assertJobAuthority(actual);
  assertJobAuthority(expected);
  if (jobAuthoritiesEqual(actual, expected)) {
    return;
  }
  throw diagnosticError({
    code: "AUTHORITY_MISMATCH",
    message: "Job Authority does not match the authority selected before launch",
    remediation: "Retry the Job without changing its authority payload.",
  });
}

function validateComposition(authority: JobAuthority): JobAuthorityFailure | null {
  if (authority.allowFetch && authority.allowExecute) {
    return invalid(
      "fetch-execute-conflict",
      "fetch and execute authority cannot be granted to the same confined Job",
      "Sequence separate research and execution Jobs.",
    );
  }
  if (authority.allowFetch && authority.confinement !== "confined") {
    return invalid(
      "fetch-requires-confined",
      "fetch authority requires Consult-managed confinement",
      "Use --sandbox confined or remove --allow-fetch.",
    );
  }
  if (authority.allowExecute && authority.confinement !== "confined") {
    return invalid(
      "execute-requires-confined",
      "execute authority requires Consult-managed confinement",
      "Use --sandbox confined or remove --allow-exec.",
    );
  }
  if (authority.allowExecute && authority.mode !== "write") {
    return invalid(
      "execute-requires-isolated-write",
      "execute authority requires a write Job with an isolated Execution Workspace",
      "Use --write --isolated with --allow-exec, or remove --allow-exec.",
    );
  }
  return null;
}

function success(authority: JobAuthority): JobAuthoritySuccess {
  return { ok: true, authority: { ...authority } };
}

function invalid(
  reason: JobAuthorityInvalidReason,
  message: string,
  remediation: string,
): JobAuthorityFailure {
  return failure({
    code: "AUTHORITY_INVALID",
    reason,
    message,
    remediation,
  });
}

function failure(diagnostic: JobAuthorityDiagnostic): JobAuthorityFailure {
  return { ok: false, diagnostic };
}

function diagnosticError(diagnostic: JobAuthorityDiagnostic): CodedJobAuthorityError {
  const error = new Error(diagnostic.message) as CodedJobAuthorityError;
  error.code = diagnostic.code;
  error.diagnostic = diagnostic;
  return error;
}

function isJobMode(value: unknown): value is JobMode {
  return value === "read-only" || value === "write";
}

function isJobConfinement(value: unknown): value is JobConfinement {
  return value === "confined" || value === "inherit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
