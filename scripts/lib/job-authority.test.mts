import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertJobAuthority,
  assertMatchingJobAuthority,
  DEFAULT_JOB_AUTHORITY,
  jobAuthoritiesEqual,
  jobAuthorityFromRecord,
  projectLegacyJobAuthority,
  resolveJobAuthority,
  validateJobAuthority,
} from "./job-authority.mts";

test("resolveJobAuthority defaults to read-only confined authority", () => {
  const result = resolveJobAuthority();

  assert.deepEqual(result, {
    ok: true,
    authority: {
      schemaVersion: 1,
      mode: "read-only",
      confinement: "confined",
      allowFetch: false,
      allowExecute: false,
    },
  });
  assert.deepEqual(result.ok ? result.authority : null, DEFAULT_JOB_AUTHORITY);
  assert.notEqual(result.ok ? result.authority : null, DEFAULT_JOB_AUTHORITY);
});

test("resolveJobAuthority creates canonical write and fetch grants", () => {
  assert.deepEqual(resolveJobAuthority({ mode: "write" }), {
    ok: true,
    authority: {
      schemaVersion: 1,
      mode: "write",
      confinement: "confined",
      allowFetch: false,
      allowExecute: false,
    },
  });
  assert.deepEqual(resolveJobAuthority({ allowFetch: true }), {
    ok: true,
    authority: {
      schemaVersion: 1,
      mode: "read-only",
      confinement: "confined",
      allowFetch: true,
      allowExecute: false,
    },
  });
});

test("resolveJobAuthority rejects malformed fields", () => {
  const cases = [
    [{ mode: "admin" }, "unknown-mode"],
    [{ confinement: "bwrap" }, "unknown-confinement"],
    [{ allowFetch: "true" }, "non-boolean-grant"],
    [{ allowExecute: 1 }, "non-boolean-grant"],
    [{ isolated: "yes" }, "non-boolean-isolated"],
  ] as const;

  for (const [input, reason] of cases) {
    const result = resolveJobAuthority(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostic.code, "AUTHORITY_INVALID");
      assert.equal(result.diagnostic.reason, reason);
    }
  }
});

test("resolveJobAuthority rejects unsafe grant composition", () => {
  const conflict = resolveJobAuthority({ allowFetch: true, allowExecute: true });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.diagnostic.reason, "fetch-execute-conflict");
  }

  const inheritedFetch = resolveJobAuthority({
    confinement: "inherit",
    allowFetch: true,
  });
  assert.equal(inheritedFetch.ok, false);
  if (!inheritedFetch.ok) {
    assert.equal(inheritedFetch.diagnostic.reason, "fetch-requires-confined");
  }

  const inheritedExecute = resolveJobAuthority({
    mode: "write",
    confinement: "inherit",
    allowExecute: true,
    isolated: true,
  });
  assert.equal(inheritedExecute.ok, false);
  if (!inheritedExecute.ok) {
    assert.equal(inheritedExecute.diagnostic.reason, "execute-requires-confined");
  }
});

test("resolveJobAuthority fails execute closed after structural validation", () => {
  const missingIsolated = resolveJobAuthority({
    mode: "write",
    allowExecute: true,
  });
  assert.equal(missingIsolated.ok, false);
  if (!missingIsolated.ok) {
    assert.equal(missingIsolated.diagnostic.code, "AUTHORITY_INVALID");
    assert.equal(missingIsolated.diagnostic.reason, "execute-requires-isolated-write");
  }

  const unavailable = resolveJobAuthority({
    mode: "write",
    allowExecute: true,
    isolated: true,
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.diagnostic.code, "AUTHORITY_EXECUTE_UNAVAILABLE");
    assert.equal(unavailable.diagnostic.reason, undefined);
    assert.match(unavailable.diagnostic.remediation, /Remove --allow-exec/);
  }
});

test("validateJobAuthority parses canonical persisted and protocol values", () => {
  const result = validateJobAuthority({
    schemaVersion: 1,
    mode: "write",
    confinement: "confined",
    allowFetch: false,
    allowExecute: true,
    ignoredFutureField: "compatible",
  });

  assert.deepEqual(result, {
    ok: true,
    authority: {
      schemaVersion: 1,
      mode: "write",
      confinement: "confined",
      allowFetch: false,
      allowExecute: true,
    },
  });
});

test("validateJobAuthority rejects malformed canonical values", () => {
  const cases = [
    [null, "malformed-authority"],
    [{}, "invalid-schema-version"],
    [
      {
        schemaVersion: 2,
        mode: "read-only",
        confinement: "confined",
        allowFetch: false,
        allowExecute: false,
      },
      "invalid-schema-version",
    ],
    [
      {
        schemaVersion: 1,
        mode: "read-only",
        confinement: "confined",
        allowFetch: false,
      },
      "non-boolean-grant",
    ],
  ] as const;

  for (const [value, reason] of cases) {
    const result = validateJobAuthority(value);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostic.reason, reason);
    }
  }
});

test("legacy Job records project to truthful inherited authority", () => {
  assert.deepEqual(projectLegacyJobAuthority({ mode: "write", allowExecute: true }), {
    schemaVersion: 1,
    mode: "write",
    confinement: "inherit",
    allowFetch: false,
    allowExecute: true,
  });
  assert.deepEqual(projectLegacyJobAuthority({ mode: "unknown", allowExecute: "true" }), {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "inherit",
    allowFetch: false,
    allowExecute: false,
  });
});

test("jobAuthorityFromRecord prefers canonical authority and falls back only when absent", () => {
  const canonical = jobAuthorityFromRecord({
    mode: "read-only",
    authority: {
      schemaVersion: 1,
      mode: "write",
      confinement: "confined",
      allowFetch: true,
      allowExecute: false,
    },
  });
  assert.equal(canonical.ok, true);
  if (canonical.ok) {
    assert.equal(canonical.authority.mode, "write");
    assert.equal(canonical.authority.allowFetch, true);
  }

  assert.deepEqual(jobAuthorityFromRecord({ mode: "write" }), {
    ok: true,
    authority: {
      schemaVersion: 1,
      mode: "write",
      confinement: "inherit",
      allowFetch: false,
      allowExecute: false,
    },
  });

  const malformed = jobAuthorityFromRecord({ authority: null });
  assert.equal(malformed.ok, false);
});

test("authority equality and assertions compare canonical fields", () => {
  const left = {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "confined",
    allowFetch: false,
    allowExecute: false,
  };
  const right = { ...left, ignoredFutureField: true };

  assert.equal(jobAuthoritiesEqual(left, right), true);
  assert.equal(jobAuthoritiesEqual(left, { ...right, allowFetch: true }), false);
  assert.equal(jobAuthoritiesEqual(left, null), false);
  assert.doesNotThrow(() => assertJobAuthority(left));
  assert.doesNotThrow(() => assertMatchingJobAuthority(left, right));

  assert.throws(
    () => assertJobAuthority({ ...left, mode: "admin" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_INVALID");
      return true;
    },
  );
  assert.throws(
    () => assertMatchingJobAuthority(left, { ...right, allowFetch: true }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_MISMATCH");
      return true;
    },
  );
});
