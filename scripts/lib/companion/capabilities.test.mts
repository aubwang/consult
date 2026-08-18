import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { dispatch } from "../../consult-companion.mts";
import { JOB_RESULT_SCHEMA_VERSION } from "../job-result-contract.mts";
import {
  MAX_REPORTS_PER_JOB,
  MAX_REPORT_DATA_BYTES,
  MAX_REPORT_MESSAGE_BYTES,
} from "../job-reports.mts";
import { MAX_STEER_GUIDANCE_BYTES } from "../job-steer.mts";
import { PROFILES_SCHEMA_VERSION } from "../profiles.mts";
import type { Registry } from "../registry.mts";
import { CAPABILITIES_SCHEMA_VERSION, runCapabilities } from "./capabilities.mts";
import { EVENTS_SCHEMA_VERSION } from "./events.mts";

test("capabilities --json reports the versioned envelope a Host branches on", async () => {
  const result = await runCapabilities({
    args: { positional: [], flags: { json: true } },
    deps: { loadRegistry: async () => registry(), version: () => "9.9.9" },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), [
    "schemaVersion",
    "version",
    "contracts",
    "features",
    "bounds",
  ]);
  assert.equal(report.schemaVersion, CAPABILITIES_SCHEMA_VERSION);
  assert.equal(report.version, "9.9.9");
  assert.deepEqual(Object.keys(report.contracts), ["jobResult", "events", "profiles"]);
  assert.deepEqual(Object.keys(report.features), [
    "report",
    "events",
    "steer",
    "reportExec",
    "nativeReviewProfiles",
  ]);
  assert.deepEqual(Object.keys(report.bounds), [
    "reportMessageBytes",
    "reportDataBytes",
    "reportsPerJob",
    "steerGuidanceBytes",
  ]);
});

// A bound that moves without this report moving would be worse than no report,
// so the assertions compare against the constants the behavior itself uses.
test("capabilities reports the constants the commands are actually bounded by", async () => {
  const result = await runCapabilities({
    args: { positional: [], flags: { json: true } },
    deps: { loadRegistry: async () => registry() },
  });
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.contracts, {
    jobResult: JOB_RESULT_SCHEMA_VERSION,
    events: EVENTS_SCHEMA_VERSION,
    profiles: PROFILES_SCHEMA_VERSION,
  });
  assert.deepEqual(report.bounds, {
    reportMessageBytes: MAX_REPORT_MESSAGE_BYTES,
    reportDataBytes: MAX_REPORT_DATA_BYTES,
    reportsPerJob: MAX_REPORTS_PER_JOB,
    steerGuidanceBytes: MAX_STEER_GUIDANCE_BYTES,
  });
});

test("capabilities lists the Profiles the registry advertises native review for", async () => {
  const none = await runCapabilities({
    args: { positional: [], flags: { json: true } },
    deps: { loadRegistry: async () => ({ schemaVersion: 1, agents: [] }) },
  });
  const some = await runCapabilities({
    args: { positional: [], flags: { json: true } },
    deps: { loadRegistry: async () => registry() },
  });

  assert.deepEqual(JSON.parse(none.stdout).features.nativeReviewProfiles, []);
  assert.deepEqual(JSON.parse(some.stdout).features.nativeReviewProfiles, ["codex"]);
});

test("capabilities prints a readable table without --json", async () => {
  const result = await runCapabilities({
    args: { positional: [], flags: {} },
    deps: { loadRegistry: async () => registry(), version: () => "9.9.9" },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^consult 9\.9\.9\n/u);
  assert.match(result.stdout, /\ncontract\tversion\n/u);
  assert.match(result.stdout, /\nfeature\tavailable\n/u);
  assert.match(result.stdout, /\nsteer\tyes\n/u);
  assert.match(result.stdout, /\nnativeReview\tcodex\n/u);
  assert.match(result.stdout, /\nbound\tvalue\n/u);
  assert.match(result.stdout, new RegExp(`\nreportsPerJob\t${MAX_REPORTS_PER_JOB}\n`, "u"));
});

test("capabilities names no configured Profiles when the registry advertises none", async () => {
  const result = await runCapabilities({
    args: { positional: [], flags: {} },
    deps: { loadRegistry: async () => ({ schemaVersion: 1, agents: [] }) },
  });

  assert.match(result.stdout, /\nnativeReview\t\(none\)\n/u);
});

// Capabilities is a static self-description like help and version: a Host may
// probe it from anywhere, including a directory that is not a Git checkout.
test("capabilities answers outside a Git Workspace", async (t) => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "consult-capabilities-"));
  withCwd(t, outside);

  const direct = await runCapabilities({ args: { positional: [], flags: { json: true } } });
  const dispatched = await dispatch("capabilities", { positional: [], flags: { json: true } });
  const workspaceCommand = await dispatch("status", { positional: [], flags: {} });

  assert.equal(direct.exitCode, 0);
  assert.equal(dispatched.exitCode, 0);
  assert.equal(JSON.parse(dispatched.stdout).schemaVersion, CAPABILITIES_SCHEMA_VERSION);
  // The contrast the command exists for: an ordinary Job command needs a
  // Workspace here and says so.
  assert.equal(workspaceCommand.exitCode, 2);
  assert.match(workspaceCommand.stderr, /no workspace found/u);
});

test("capabilities rejects unknown flags and a non-boolean --json", async () => {
  const unknown = await runCapabilities({
    args: { positional: [], flags: { agent: "claude" } },
    deps: { loadRegistry: async () => registry() },
  });
  const badBoolean = await runCapabilities({
    args: { positional: [], flags: { json: "maybe" } },
    deps: { loadRegistry: async () => registry() },
  });

  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /--agent is not supported by this command/u);
  assert.equal(badBoolean.exitCode, 2);
  assert.equal(badBoolean.stderr, "--json must be true or false\n");
});

test("capabilities rejects positional arguments", async () => {
  const result = await runCapabilities({
    args: { positional: ["unexpected"], flags: {} },
    deps: { loadRegistry: async () => registry() },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "unexpected argument: unexpected\n");
});

test("capabilities surfaces a malformed registry as a usage error", async () => {
  const malformed = Object.assign(new Error("Registry file is malformed"), {
    code: "REGISTRY_MALFORMED",
    path: "/tmp/registry.json",
  });

  const result = await runCapabilities({
    args: { positional: [], flags: { json: true } },
    deps: {
      loadRegistry: async () => {
        throw malformed;
      },
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "registry malformed: /tmp/registry.json\n");
});

function registry(): Registry {
  return {
    schemaVersion: 1,
    agents: [
      {
        id: "codex",
        label: "Codex",
        binary: "codex-acp",
        args: [],
        install: { type: "npm", cmd: "npm i -g codex-acp" },
        supports: { resume: true, load: true },
        advertisesReview: true,
      },
      {
        id: "claude",
        label: "Claude",
        binary: "claude-agent-acp",
        args: [],
        install: { type: "npm", cmd: "npm i -g claude-agent-acp" },
        supports: { resume: true, load: true },
      },
    ],
  };
}

function withCwd(t: TestContext, directory: string): void {
  const original = process.cwd();
  process.chdir(directory);
  t.after(() => {
    process.chdir(original);
  });
}
