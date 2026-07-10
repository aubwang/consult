import assert from "node:assert/strict";
import { test } from "node:test";

import { hashRunPayload } from "./job-agent.mts";

const BASE_RUN = {
  jobId: "job-1",
  prompt: "run tests",
  profile: "codex",
  mode: "write",
};

test("hashRunPayload includes the explicit execute opt-in", () => {
  const defaultHash = hashRunPayload(BASE_RUN);
  const falseHash = hashRunPayload({ ...BASE_RUN, allowExecute: false });
  const enabledHash = hashRunPayload({ ...BASE_RUN, allowExecute: true });

  assert.equal(defaultHash, falseHash);
  assert.notEqual(enabledHash, defaultHash);
});

test("hashRunPayload does not treat a string value as execute opt-in", () => {
  assert.equal(
    hashRunPayload({ ...BASE_RUN, allowExecute: "true" as unknown as boolean }),
    hashRunPayload(BASE_RUN),
  );
});
