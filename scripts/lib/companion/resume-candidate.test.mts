import assert from "node:assert/strict";
import { test } from "node:test";

import { findResumeCandidate, findResumeJobCandidate } from "./resume-candidate.mts";

test("findResumeCandidate returns the latest resumable job in scope", async () => {
  const records = [
    resumableJob("job-old", "codex", "session-old", "2026-05-21T10:00:00.000Z"),
    resumableJob("job-new", "codex", "session-new", "2026-05-21T11:00:00.000Z"),
    { ...resumableJob("job-other-host", "codex", "session-other", "2026-05-21T12:00:00.000Z"), host: "other" },
    { ...resumableJob("job-running", "codex", "session-running", "2026-05-21T13:00:00.000Z"), status: "running" },
    resumableJob("job-claude", "claude", "session-claude", "2026-05-21T14:00:00.000Z"),
  ];

  assert.equal(
    (
      await findResumeCandidate("/workspace", "codex", {
        host: "codex",
        hostSessionId: "thread-1",
        listJobRecords: async () => records,
      })
    ).jobId,
    "job-new",
  );
});

test("findResumeJobCandidate validates profile ownership and resumability", async () => {
  assert.deepEqual(
    await findResumeJobCandidate("/workspace", "job-1", "codex", {
      readJobRecord: async () => resumableJob("job-1", "codex", "session-1"),
    }),
    { record: resumableJob("job-1", "codex", "session-1") },
  );
  assert.deepEqual(
    await findResumeJobCandidate("/workspace", "job-2", "codex", {
      readJobRecord: async () => resumableJob("job-2", "claude", "session-2"),
    }),
    {
      error:
        "resume job 'job-2' belongs to profile 'claude'; select profile 'claude' or choose a codex job",
    },
  );
  assert.deepEqual(
    await findResumeJobCandidate("/workspace", "job-3", "codex", {
      readJobRecord: async () => ({ ...resumableJob("job-3", "codex", "session-3"), sessionId: null as unknown as undefined }),
    }),
    { error: "resume job 'job-3' is not resumable" },
  );
});

function resumableJob(
  jobId: string,
  profile: string,
  sessionId: string,
  completedAt: string = "2026-05-21T10:00:00.000Z",
) {
  return {
    jobId,
    profile,
    sessionId,
    completedAt,
    status: "completed",
    host: "codex",
    hostSessionId: "thread-1",
  };
}
