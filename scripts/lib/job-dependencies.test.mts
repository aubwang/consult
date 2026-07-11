import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendUpstreamJobResults,
  waitForJobDependencies,
} from "./job-dependencies.mts";

test("appendUpstreamJobResults bounds UTF-8 data and labels it as untrusted", () => {
  const prompt = appendUpstreamJobResults(
    "Synthesize the research.",
    [
      {
        jobId: "job-research",
        profile: "claude",
        finalText: `1234€${"x".repeat(100)}`,
      },
    ],
    7,
  );

  assert.match(prompt, /^Synthesize the research\./u);
  assert.match(prompt, /UNTRUSTED DATA/u);
  assert.match(prompt, /\[consult: upstream Job Results truncated\]/u);
  assert.doesNotMatch(prompt, /�/u);
});

test("waitForJobDependencies reads all prerequisites until each is terminal", async () => {
  let completed = false;
  let polls = 0;

  const records = await waitForJobDependencies({
    jobIds: ["job-a", "job-b"],
    readRecord: async (jobId) => ({
      jobId,
      status: jobId === "job-a" || completed ? "completed" : "running",
    }),
    poll: async () => {
      polls += 1;
      completed = true;
    },
  });

  assert.equal(polls, 1);
  assert.deepEqual(records.map((record) => record.status), ["completed", "completed"]);
});
