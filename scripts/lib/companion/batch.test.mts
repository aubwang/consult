import assert from "node:assert/strict";
import { test } from "node:test";
import { batchRequests, runBatch } from "./batch.mts";
import type { JobBatch } from "../job-batch.mts";

test("batch validates every entry and requires explicit isolated writers before submitting", async () => {
  let launched = 0;
  const result = await runBatch({ positional: ["tasks.json"], flags: {} }, {
    readFile: async () => JSON.stringify({ jobs: [{ prompt: "review" }, { prompt: "implement", write: true }] }),
    delegate: async () => { launched++; throw new Error("must not launch"); },
  });
  assert.equal(result.exitCode, 2); assert.equal(launched, 0);
  assert.match(result.stderr, /isolated/);
  assert.throws(() => batchRequests({ jobs: Array.from({ length: 9 }, () => ({ prompt: "review" })) }, {}), /1-8/);
  assert.throws(() => batchRequests({ jobs: [{ prompt: "review", surprise: true }] }, {}), /unsupported/);
});

test("batch persists each id and keeps a partial receipt when a later launch fails", async () => {
  const saved: JobBatch[] = [];
  let count = 0;
  const result = await runBatch({ positional: ["tasks.json"], flags: { json: true, agent: "pi", sandbox: "inherit" } }, {
    readFile: async () => JSON.stringify({ jobs: [{ prompt: "one", label: "first" }, { prompt: "two" }] }),
    resolveWorkspaceRoot: async () => "/workspace",
    writeBatch: async (_root, batch) => { saved.push(structuredClone(batch)); },
    delegate: async ({ args }) => {
      assert.equal(args.flags.agent, "pi"); assert.equal(args.flags.sandbox, "inherit"); assert.equal(args.flags.background, true);
      return ++count === 1 ? { exitCode: 0, stdout: JSON.stringify({ job: { id: "job-one" } }), stderr: "" } : { exitCode: 2, stdout: "", stderr: "unavailable Profile" };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout).jobIds, ["job-one"]);
  assert.equal(saved.at(-1)?.submitted, false);
  assert.match(saved.at(-1)!.error!, /unavailable Profile/);
});
