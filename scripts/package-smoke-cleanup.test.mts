import assert from "node:assert/strict";
import test from "node:test";

import { removePackageTemporaryRoot } from "./package-smoke-cleanup.mts";

test("package smoke cleanup retries transient ENOTEMPTY directory races", async () => {
  let attempts = 0;
  const waits: number[] = [];

  await removePackageTemporaryRoot("/tmp/package-smoke", {
    remove: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
      }
    },
    wait: async (ms: number) => {
      waits.push(ms);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("package smoke cleanup does not retry other removal failures", async () => {
  let attempts = 0;

  await assert.rejects(
    removePackageTemporaryRoot("/tmp/package-smoke", {
      remove: async () => {
        attempts += 1;
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      wait: async () => {},
    }),
    { code: "EACCES" },
  );

  assert.equal(attempts, 1);
});
