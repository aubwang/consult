import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { brokersDir, jobsDir, profilesPath } from "../broker-endpoint.mts";
import { runDoctor } from "./doctor.mts";
import type { DoctorReport } from "./doctor.mts";

test("doctor json reports selected profile, job counts, broker counts, and authority readiness", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    hostDefaults: { codex: "claude" },
    profiles: {
      codex: profile("codex"),
      claude: profile("claude"),
    },
  });
  await writeJob(workspaceRoot, {
    jobId: "queued",
    status: "queued",
    submittedAt: "2026-06-13T10:00:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "running",
    status: "running",
    submittedAt: "2026-06-13T10:01:00.000Z",
  });
  await writeJob(workspaceRoot, {
    jobId: "completed",
    status: "completed",
    submittedAt: "2026-06-13T10:02:00.000Z",
  });
  await writeBroker(workspaceRoot, "live", { pid: 111 });
  await writeBroker(workspaceRoot, "dead", { pid: 222 });
  await writeRawBroker(workspaceRoot, "bad", "{");

  const result = await runDoctor({
    args: { positional: [], flags: { json: true } },
    env: {
      CONSULT_HOST: "codex",
      CONSULT_HOST_SESSION_ID: "thread-1",
      CONSULT_AGENT_SANDBOX: "bwrap",
      PATH: "/bin",
    },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      pidAlive: async (pid) => pid === 111,
      platform: "linux",
      probeConfined: async ({ authority }) => ({ ok: true, authority }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(report.canDelegate, true);
  assert.equal(report.workspaceRoot, workspaceRoot);
  assert.equal(report.profile.host, "codex");
  assert.equal(report.profile.hostSessionId, "thread-1");
  assert.equal(report.profile.configuredProfiles, 2);
  assert.equal(report.profile.defaultProfile, "codex");
  assert.equal(report.profile.hostDefaultProfile, "claude");
  assert.equal(report.profile.selectedProfile, "claude");
  assert.deepEqual(
    {
      total: report.jobs.total,
      queued: report.jobs.queued,
      running: report.jobs.running,
      final: report.jobs.final,
      completed: report.jobs.completed,
    },
    { total: 3, queued: 1, running: 1, final: 1, completed: 1 },
  );
  assert.deepEqual(
    {
      total: report.brokers.total,
      running: report.brokers.running,
      stale: report.brokers.stale,
      malformed: report.brokers.malformed,
    },
    { total: 3, running: 1, stale: 1, malformed: 1 },
  );
  assert.equal(report.authority.ok, true);
  assert.equal(report.authority.confined.ok, true);
  assert.equal(report.authority.selectedProfile, "claude");
  assert.equal(report.authority.profileRegistryId, "claude");
  assert.equal(report.authority.defaultAuthority.confinement, "confined");
  assert.equal(report.authority.inherit.available, true);
  assert.equal(report.authority.legacySandboxEnv, "bwrap");
});

test("doctor human output reports missing profile setup as not delegate-ready", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);

  const result = await runDoctor({
    args: { positional: [], flags: {} },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
    },
  });

  // Doctor exits 1 when the workspace is not delegate-ready.
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Consult doctor/);
  assert.match(result.stdout, /canDelegate: no/);
  assert.match(result.stdout, /profile\/setup:/);
  assert.match(result.stdout, /No profile configured/);
  assert.match(result.stdout, /jobs:/);
  assert.match(result.stdout, /brokers:/);
  assert.match(result.stdout, /job authority:/);
});

test("doctor marks default confinement unready with the probe diagnostic", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    hostDefaults: {},
    profiles: { codex: profile("codex") },
  });

  const result = await runDoctor({
    args: { positional: [], flags: { json: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "darwin",
      arch: "arm64",
      probeConfined: async () => ({
        ok: false,
        diagnostic: {
          code: "AUTHORITY_PREFLIGHT_FAILED",
          message: "sandbox-exec: Operation not permitted",
          remediation: "Retry with --sandbox inherit only from a trusted Host.",
        },
      }),
    },
  });

  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(result.exitCode, 1);
  assert.equal(report.canDelegate, false);
  assert.equal(report.authority.ok, false);
  assert.equal(report.authority.confined.ok, false);
  assert.equal(
    report.authority.confined.diagnostic?.message,
    "sandbox-exec: Operation not permitted",
  );
  assert.equal(report.authority.inherit.available, true);
});

test("doctor reports macOS x64 unsupported without an inheritance escape hatch", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    hostDefaults: {},
    profiles: { codex: profile("codex") },
  });

  const result = await runDoctor({
    args: { positional: [], flags: { json: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "darwin",
      arch: "x64",
      probeConfined: async () => {
        throw new Error("confined probe must not run");
      },
      probeInherited: async () => {
        throw new Error("inherited probe must not run");
      },
    },
  });

  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(result.exitCode, 1);
  assert.equal(report.authority.arch, "x64");
  assert.equal(report.authority.confined.ok, false);
  assert.equal(
    report.authority.confined.diagnostic?.code,
    "AUTHORITY_PLATFORM_UNSUPPORTED",
  );
  assert.equal(report.authority.inherit.available, false);
});

test("doctor validates an explicitly inherited Profile even when default confinement is unavailable", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "opencode",
    hostDefaults: {},
    profiles: { opencode: profile("opencode") },
  });

  const result = await runDoctor({
    args: {
      positional: [],
      flags: { json: true, sandbox: "inherit", agent: "opencode" },
    },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "linux",
      probeInherited: async ({ authority }) => ({ ok: true, authority }),
      probeConfined: async () => ({
        ok: false,
        diagnostic: {
          code: "AUTHORITY_COMBINATION_UNSUPPORTED",
          message: "opencode confinement unavailable",
          remediation: "Use explicit inheritance.",
        },
      }),
    },
  });

  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(result.exitCode, 0);
  assert.equal(report.canDelegate, true);
  assert.equal(report.authority.requested.ok, true);
  assert.equal(report.authority.requestedAuthority?.confinement, "inherit");
  assert.equal(report.authority.confined.ok, false);
});

test("doctor reports malformed job records inside the diagnostic payload", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    hostDefaults: {},
    profiles: { codex: profile("codex") },
  });
  const recordPath = await writeRawJob(workspaceRoot, "bad", "null");

  const result = await runDoctor({
    args: { positional: [], flags: { json: true } },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      probeConfined: async ({ authority }) => ({ ok: true, authority }),
    },
  });

  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(report.canDelegate, false);
  assert.equal(report.jobs.ok, false);
  assert.equal(report.jobs.error, `JOB_RECORD_MALFORMED: ${recordPath}`);
});

test("doctor reports an expiring Claude OAuth credential without blocking delegation", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "claude",
    hostDefaults: {},
    profiles: { claude: profile("claude") },
  });

  const jsonResult = await runDoctor({
    args: { positional: [], flags: { json: true } },
    env: { CONSULT_HOST: "terminal", PATH: "/bin" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "linux",
      probeConfined: async ({ authority }) => ({ ok: true, authority }),
      inspectClaudeHostOauth: async () => ({
        state: "expiring",
        expiresAt: 2_000_000_000_000,
        skewMs: 120_000,
      }),
    },
  });
  const report = JSON.parse(jsonResult.stdout) as DoctorReport;
  assert.equal(report.canDelegate, true);
  assert.equal(report.authority.claudeOauth?.state, "expiring");

  const humanResult = await runDoctor({
    args: { positional: [], flags: {} },
    env: { CONSULT_HOST: "terminal", PATH: "/bin" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "linux",
      probeConfined: async ({ authority }) => ({ ok: true, authority }),
      inspectClaudeHostOauth: async () => ({
        state: "expiring",
        expiresAt: 2_000_000_000_000,
        skewMs: 120_000,
      }),
    },
  });
  assert.match(humanResult.stdout, /claude oauth: expiring within 120000ms/u);
  assert.match(humanResult.stdout, /claude setup-token/u);
});

test("doctor omits the Claude OAuth line for a non-claude profile", async (t) => {
  const { workspaceRoot, dataDir } = await makeWorkspace();
  withDataDir(t, dataDir);
  await writeProfiles({
    schemaVersion: 1,
    default: "codex",
    hostDefaults: {},
    profiles: { codex: profile("codex") },
  });

  const result = await runDoctor({
    args: { positional: [], flags: { json: true } },
    env: { CONSULT_HOST: "terminal", PATH: "/bin" },
    deps: {
      resolveWorkspaceRoot: async () => workspaceRoot,
      platform: "linux",
      probeConfined: async ({ authority }) => ({ ok: true, authority }),
      inspectClaudeHostOauth: async () => {
        throw new Error("must not inspect Claude OAuth for a codex profile");
      },
    },
  });
  const report = JSON.parse(result.stdout) as DoctorReport;
  assert.equal(report.authority.claudeOauth, null);
});

async function makeWorkspace(): Promise<{ workspaceRoot: string; dataDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-doctor-"));
  const workspaceRoot = path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  return { workspaceRoot, dataDir };
}

function withDataDir(t: { after: (fn: () => void) => void }, dataDir: string): void {
  const originalDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = dataDir;
  t.after(() => {
    if (originalDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = originalDataDir;
    }
  });
}

function profile(name: string): Record<string, unknown> {
  return {
    registryId: name,
    binary: name,
    args: [],
    env: {},
    installedAt: "2026-06-13T10:00:00.000Z",
  };
}

async function writeProfiles(data: Record<string, unknown>): Promise<void> {
  const filePath = profilesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data), "utf8");
}

async function writeJob(workspaceRoot: string, record: Record<string, unknown>): Promise<void> {
  await writeRawJob(workspaceRoot, record.jobId as string, JSON.stringify(record));
}

async function writeRawJob(
  workspaceRoot: string,
  jobId: string,
  content: string,
): Promise<string> {
  const dir = jobsDir(workspaceRoot);
  const recordPath = path.join(dir, `${jobId}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(recordPath, content, "utf8");
  return recordPath;
}

async function writeBroker(
  workspaceRoot: string,
  name: string,
  state: Record<string, unknown>,
): Promise<void> {
  await writeRawBroker(workspaceRoot, name, JSON.stringify(state));
}

async function writeRawBroker(
  workspaceRoot: string,
  name: string,
  content: string,
): Promise<void> {
  const dir = brokersDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), content, "utf8");
}
