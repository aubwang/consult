import assert from "node:assert/strict";
import { test } from "node:test";

import { hashRunPayload } from "./job-agent.mts";

const BASE_RUN = {
  jobId: "job-1",
  prompt: "run tests",
  profile: "codex",
  mode: "write",
};

test("hashRunPayload includes canonical execute authority", () => {
  const authority = {
    schemaVersion: 1 as const,
    mode: "write" as const,
    confinement: "confined" as const,
    allowFetch: false,
    allowExecute: false,
  };
  const defaultHash = hashRunPayload({ ...BASE_RUN, authority });
  const enabledHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...authority, allowExecute: true },
    allowExecute: true,
  });

  assert.notEqual(enabledHash, defaultHash);
});

test("hashRunPayload rejects legacy execute payloads with a stable diagnostic", () => {
  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, allowExecute: true }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_EXECUTE_UNAVAILABLE");
      assert.match((error as Error).message, /legacy execute authority is unavailable/);
      return true;
    },
  );
});

test("hashRunPayload does not treat a string value as execute opt-in", () => {
  assert.equal(
    hashRunPayload({ ...BASE_RUN, allowExecute: "true" as unknown as boolean }),
    hashRunPayload(BASE_RUN),
  );
});

test("hashRunPayload includes canonical confinement and fetch authority", () => {
  const authority = {
    schemaVersion: 1 as const,
    mode: "write" as const,
    confinement: "confined" as const,
    allowFetch: false,
    allowExecute: false,
  };

  const confinedHash = hashRunPayload({ ...BASE_RUN, authority });
  const fetchHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...authority, allowFetch: true },
  });
  const inheritedHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...authority, confinement: "inherit", allowFetch: false },
  });

  assert.notEqual(fetchHash, confinedHash);
  assert.notEqual(inheritedHash, confinedHash);
});

test("hashRunPayload canonicalizes authority while ignoring future fields", () => {
  const authority = {
    schemaVersion: 1 as const,
    mode: "read-only" as const,
    confinement: "confined" as const,
    allowFetch: false,
    allowExecute: false,
  };
  const canonicalHash = hashRunPayload({
    ...BASE_RUN,
    mode: "read-only",
    allowExecute: false,
    authority,
  });
  const extraFieldHash = hashRunPayload({
    ...BASE_RUN,
    mode: "read-only",
    allowExecute: false,
    authority: { ...authority, ignoredFutureField: "compatible" } as typeof authority,
  });

  assert.equal(canonicalHash, extraFieldHash);
});

test("hashRunPayload rejects stale flat compatibility fields", () => {
  const authority = {
    schemaVersion: 1 as const,
    mode: "read-only" as const,
    confinement: "confined" as const,
    allowFetch: false,
    allowExecute: false,
  };

  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, authority }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_MISMATCH");
      return true;
    },
  );
});

test("hashRunPayload rejects malformed explicit authority", () => {
  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, authority: null as never }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_INVALID");
      return true;
    },
  );
});
