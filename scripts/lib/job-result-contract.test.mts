import assert from "node:assert/strict";
import { test } from "node:test";

import { jobResultEnvelope } from "./job-result-contract.mts";
import type { JobAuthority } from "./job-authority.mts";

test("job result envelope exposes a stable versioned shape without internal fields", () => {
  const envelope = jobResultEnvelope(
    {
      jobId: "job-1",
      kind: "delegate",
      status: "completed",
      profile: "codex",
      mode: "write",
      host: "terminal",
      hostSessionId: "terminal-1",
      prompt: "fix it",
      submittedAt: "2026-07-09T10:00:00.000Z",
      startedAt: "2026-07-09T10:00:01.000Z",
      completedAt: "2026-07-09T10:00:02.000Z",
      model: "gpt-5",
      effort: "high",
      resumeSessionId: "session-previous",
      baseRef: "origin/main",
      includeDiff: true,
      isolated: true,
      allowExecute: true,
      authority: {
        schemaVersion: 1,
        mode: "write",
        confinement: "confined",
        allowFetch: true,
        allowExecute: false,
        ignoredFutureField: "must not leak",
      } as JobAuthority & Record<string, unknown>,
      patchPath: "/state/changes.patch",
      patchBytes: 321,
      touchedFilesPath: "/state/touched-files.json",
      cleanupMetadataPath: "/state/cleanup.json",
      stopReason: "end_turn",
      sessionId: "session-1",
      finalText: "done",
      touchedFiles: ["inside.ts", 42 as unknown as string],
      chainId: "job-root",
      parentJobId: "job-root",
      delegationDepth: 1,
      runnerPid: 123,
      privateFutureField: "must not leak",
    },
    {
      childJobIds: ["job-child"],
      logPath: "/workspace/.consult/logs/job-1.log",
    },
  );

  assert.deepEqual(envelope, {
    schemaVersion: 1,
    job: {
      id: "job-1",
      kind: "delegate",
      status: "completed",
      profile: "codex",
      mode: "write",
      host: "terminal",
      hostSessionId: "terminal-1",
      prompt: "fix it",
      submittedAt: "2026-07-09T10:00:00.000Z",
      startedAt: "2026-07-09T10:00:01.000Z",
      completedAt: "2026-07-09T10:00:02.000Z",
      model: "gpt-5",
      effort: "high",
      resumeSessionId: "session-previous",
      baseRef: "origin/main",
      includeDiff: true,
      isolated: true,
      allowExecute: true,
      authority: {
        schemaVersion: 1,
        mode: "write",
        confinement: "confined",
        allowFetch: true,
        allowExecute: false,
      },
    },
    outcome: {
      stopReason: "end_turn",
      sessionId: "session-1",
      errorMessage: null,
      finalText: "done",
    },
    artifacts: {
      touchedFiles: ["inside.ts"],
      logPath: "/workspace/.consult/logs/job-1.log",
      patchPath: "/state/changes.patch",
      patchBytes: 321,
      touchedFilesPath: "/state/touched-files.json",
      cleanupMetadataPath: "/state/cleanup.json",
    },
    lineage: {
      chainId: "job-root",
      parentJobId: "job-root",
      childJobIds: ["job-child"],
      delegationDepth: 1,
    },
  });
  assert.equal("runnerPid" in envelope.job, false);
  assert.equal("privateFutureField" in envelope.job, false);
});

test("job result envelope uses explicit nulls and empty artifact lists", () => {
  const envelope = jobResultEnvelope({ jobId: "job-queued", status: "queued" });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.job.id, "job-queued");
  assert.equal(envelope.job.profile, null);
  assert.equal(envelope.job.mode, null);
  assert.equal(envelope.job.includeDiff, false);
  assert.deepEqual(envelope.job.authority, {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "inherit",
    allowFetch: false,
    allowExecute: false,
  });
  assert.equal(envelope.outcome.finalText, null);
  assert.deepEqual(envelope.artifacts.touchedFiles, []);
  assert.deepEqual(envelope.lineage.childJobIds, []);
});

test("legacy Job result authority reflects ambient mode and execute fields", () => {
  const envelope = jobResultEnvelope({
    jobId: "job-legacy",
    mode: "write",
    allowExecute: true,
  });

  assert.deepEqual(envelope.job.authority, {
    schemaVersion: 1,
    mode: "write",
    confinement: "inherit",
    allowFetch: false,
    allowExecute: true,
  });
  assert.equal(envelope.job.mode, "write");
  assert.equal(envelope.job.allowExecute, true);
});
