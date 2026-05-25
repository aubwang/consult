import assert from "node:assert/strict";
import { test } from "node:test";

import { jobRecordErrorResult } from "./job-record-errors.mjs";
import { profileErrorResult } from "./profile-errors.mjs";
import { workspaceOverrideErrorResult } from "./workspace-override-errors.mjs";

test("profileErrorResult maps profile file errors to CLI results", () => {
  assert.deepEqual(
    profileErrorResult({ code: "PROFILES_MALFORMED", path: "/tmp/profiles.json" }),
    {
      exitCode: 2,
      stdout: "",
      stderr: "profiles malformed: /tmp/profiles.json\n",
    },
  );
  assert.deepEqual(
    profileErrorResult({ code: "PROFILES_SCHEMA_MISMATCH", path: "/tmp/profiles.json" }),
    {
      exitCode: 2,
      stdout: "",
      stderr: "profiles schema mismatch: /tmp/profiles.json\n",
    },
  );
  assert.equal(profileErrorResult({ code: "OTHER" }), null);
});

test("jobRecordErrorResult maps malformed job records to CLI results", () => {
  assert.deepEqual(jobRecordErrorResult({ code: "JOB_RECORD_MALFORMED", path: "/tmp/job.json" }), {
    exitCode: 2,
    stdout: "",
    stderr: "job record malformed: /tmp/job.json\n",
  });
  assert.equal(jobRecordErrorResult({ code: "OTHER" }), null);
});

test("workspaceOverrideErrorResult maps malformed override records to CLI results", () => {
  assert.deepEqual(
    workspaceOverrideErrorResult({
      code: "WORKSPACE_OVERRIDE_MALFORMED",
      path: "/tmp/override.json",
    }),
    {
      exitCode: 2,
      stdout: "",
      stderr: "workspace override malformed: /tmp/override.json\n",
    },
  );
  assert.equal(workspaceOverrideErrorResult({ code: "OTHER" }), null);
});
