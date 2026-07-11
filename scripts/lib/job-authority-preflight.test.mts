import assert from "node:assert/strict";
import { test } from "node:test";

import {
  preflightJobAuthority,
  validateJobAuthorityRuntimeBoundary,
} from "./job-authority-preflight.mts";
import type { JobAuthority } from "./job-authority.mts";

const CONFINED: JobAuthority = {
  schemaVersion: 1,
  mode: "read-only",
  confinement: "confined",
  allowFetch: false,
  allowExecute: false,
};
const INHERIT: JobAuthority = { ...CONFINED, confinement: "inherit" };
const BASE = {
  workspaceRoot: "/workspace",
  profile: "fable",
  profileRegistryId: "claude",
};

test("preflight accepts explicit inheritance on supported platforms", async () => {
  assert.deepEqual(
    await preflightJobAuthority(
      { ...BASE, authority: INHERIT, platform: "linux" },
      { probeInherited: async ({ authority }) => ({ ok: true, authority }) },
    ),
    { ok: true, authority: INHERIT },
  );
});

test("preflight rejects native Windows including inheritance", async () => {
  const result = await preflightJobAuthority({
    ...BASE,
    authority: INHERIT,
    platform: "win32",
  }, { probeInherited: async ({ authority }) => ({ ok: true, authority }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.code, "AUTHORITY_PLATFORM_UNSUPPORTED");
});

test("preflight rejects Intel macOS including inheritance", async () => {
  const result = await preflightJobAuthority({
    ...BASE,
    authority: INHERIT,
    platform: "darwin",
    arch: "x64",
  }, { probeInherited: async ({ authority }) => ({ ok: true, authority }) });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "AUTHORITY_PLATFORM_UNSUPPORTED");
    assert.match(result.diagnostic.message, /Intel macOS/u);
  }
});

test("runtime boundary rejects persisted execute grants and native Windows", () => {
  const execute = validateJobAuthorityRuntimeBoundary({
    authority: { ...CONFINED, mode: "write", allowExecute: true },
    platform: "linux",
  });
  assert.equal(execute.ok, false);
  if (!execute.ok) {
    assert.equal(execute.diagnostic.code, "AUTHORITY_EXECUTE_UNAVAILABLE");
  }

  const windows = validateJobAuthorityRuntimeBoundary({
    authority: INHERIT,
    platform: "win32",
  });
  assert.equal(windows.ok, false);
  if (!windows.ok) {
    assert.equal(windows.diagnostic.code, "AUTHORITY_PLATFORM_UNSUPPORTED");
  }

  const freebsd = validateJobAuthorityRuntimeBoundary({
    authority: INHERIT,
    platform: "freebsd",
  });
  assert.equal(freebsd.ok, false);
  if (!freebsd.ok) {
    assert.equal(freebsd.diagnostic.code, "AUTHORITY_PLATFORM_UNSUPPORTED");
  }
});

test("preflight rejects every chain involving confined authority", async () => {
  for (const [authority, parentAuthority] of [
    [CONFINED, INHERIT],
    [INHERIT, CONFINED],
    [CONFINED, CONFINED],
  ] as const) {
    const result = await preflightJobAuthority({
      ...BASE,
      authority,
      platform: "linux",
      parentJob: { authority: parentAuthority },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostic.code, "AUTHORITY_NESTED_CONFINED_UNSUPPORTED");
    }
  }
});

test("preflight retains cooperative inherit-to-inherit chains", async () => {
  const result = await preflightJobAuthority(
    {
      ...BASE,
      authority: INHERIT,
      platform: "linux",
      parentJob: { mode: "read-only" },
    },
    { probeInherited: async ({ authority }) => ({ ok: true, authority }) },
  );
  assert.deepEqual(result, { ok: true, authority: INHERIT });
});

test("preflight fails confined authority closed when no backend probe exists", async () => {
  const result = await preflightJobAuthority({
    ...BASE,
    authority: CONFINED,
    platform: "linux",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "AUTHORITY_COMBINATION_UNSUPPORTED");
    assert.match(result.diagnostic.remediation, /--sandbox inherit/);
  }
});

test("preflight returns probe results and converts probe exceptions", async () => {
  const pass = await preflightJobAuthority(
    { ...BASE, authority: CONFINED, platform: "linux" },
    { probeConfined: async ({ authority }) => ({ ok: true, authority }) },
  );
  assert.deepEqual(pass, { ok: true, authority: CONFINED });

  const failed = await preflightJobAuthority(
    { ...BASE, authority: CONFINED, platform: "linux" },
    { probeConfined: async () => { throw new Error("nested bwrap denied"); } },
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.diagnostic.code, "AUTHORITY_PREFLIGHT_FAILED");
    assert.match(failed.diagnostic.message, /nested bwrap denied/);
  }
});
