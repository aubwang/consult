import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  newSession,
  promptTurn,
  startAgent,
} from "./lib/acp-client.mts";
import { profilesPath } from "./lib/broker-endpoint.mts";
import {
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "./lib/job-records.mts";
import { loadProfiles } from "./lib/profiles.mts";
import { extractAgentMessageText } from "./lib/session-update-renderer.mts";
import { applySessionControls } from "./lib/session-controls.mts";
import { resolveWorkspaceRoot } from "./lib/workspace.mts";

const companionPath = fileURLToPath(new URL("./consult-companion.mts", import.meta.url));
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

interface Options {
  agent: "codex" | "claude";
  expect: "ready" | "unsupported";
  model?: string;
  turn: boolean;
  direct: boolean;
  background: boolean;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface DoctorPayload {
  authority?: {
    platform?: string;
    selectedProfile?: string | null;
    profileRegistryId?: string | null;
    confined?: {
      ok?: boolean;
      diagnostic?: { code?: string; message?: string; remediation?: string } | null;
    };
  };
}

const options = parseOptions(process.argv.slice(2));
if (process.platform !== "linux" && process.platform !== "darwin") {
  throw new Error(`Job Authority conformance is unsupported on ${process.platform}`);
}
const workspaceRoot = await resolveWorkspaceRoot();
const jobsBefore = await listWorkspaceJobRecords(workspaceRoot);
const sandboxRootsBefore = await listSandboxJobRoots();

let directFailed = false;
const direct = options.direct
  ? await runDirectProfileControl(workspaceRoot, options).catch((error) => {
      directFailed = true;
      return {
        ok: false,
        diagnostic: diagnosticMessage(error),
      };
    })
  : null;

const doctorResult = await runCompanion(["doctor", "--agent", options.agent, "--json"]);
const doctor = parseJson<DoctorPayload>(doctorResult.stdout, "doctor");
const confined = doctor.authority?.confined;
if (options.expect === "ready" && confined?.ok !== true) {
  throw new Error(
    `expected confined readiness, received ${redact(confined?.diagnostic?.message ?? "no diagnostic")}`,
  );
}
if (options.expect === "ready" && doctorResult.code !== 0) {
  throw new Error(`ready Doctor exited ${String(doctorResult.code)}`);
}
if (options.expect === "unsupported") {
  if (doctorResult.code !== 1 || confined?.ok !== false) {
    throw new Error("expected confined preflight to fail closed in this Host context");
  }
  const diagnostic = confined.diagnostic;
  if (
    diagnostic?.code !== "AUTHORITY_PREFLIGHT_FAILED" ||
    !/(?:sandbox_apply|Operation not permitted|EPERM|nested)/iu.test(
      `${diagnostic.message ?? ""} ${diagnostic.remediation ?? ""}`,
    ) ||
    /(?:credential|authentication|required command|binary not found)/iu.test(
      diagnostic.message ?? ""
    )
  ) {
    throw new Error(
      `unsupported result was not the expected nesting failure: ${redact(diagnostic?.message ?? "no diagnostic")}`,
    );
  }
  const rejected = await runCompanion([
    "delegate", "--agent", options.agent, "--read-only", "--sandbox", "confined",
    "--json", "--", "This prompt must never reach a Profile.",
  ]);
  const rejectedPayload = parseJson<Record<string, any>>(rejected.stdout, "rejected delegate");
  if (
    rejected.code !== 2 ||
    rejectedPayload.error?.code !== "AUTHORITY_PREFLIGHT_FAILED"
  ) {
    throw new Error("nested delegate did not return the stable pre-Job authority failure");
  }
  const jobsAfter = await listWorkspaceJobRecords(workspaceRoot);
  if (jobsAfter.length !== jobsBefore.length) {
    throw new Error("unsupported confined delegation created a Job");
  }
}
if (options.turn && options.expect !== "ready") {
  throw new Error("--turn requires --expect ready");
}

let turn: Record<string, unknown> | null = null;
if (options.turn) {
  const sourceExpected = `CONFINED_${options.agent.toUpperCase()}_SOURCE_OK`;
  const resumeSecret = `RESUME_${options.agent.toUpperCase()}_${crypto.randomBytes(8).toString("hex")}`;
  const args = [
    "delegate",
    "--agent",
    options.agent,
    "--read-only",
    "--sandbox",
    "confined",
    "--json",
  ];
  if (options.model) args.push("--model", options.model);
  args.push(
    "--",
    `Remember the private marker ${resumeSecret} for the next turn. Reply with exactly ${sourceExpected} and do not use tools.`,
  );
  const result = await runCompanion(args);
  const payload = parseJson<Record<string, any>>(result.stdout, "delegate");
  if (
    result.code !== 0 ||
    payload.job?.status !== "completed" ||
    payload.outcome?.finalText?.trim() !== sourceExpected
  ) {
    throw new Error(
      `confined turn failed (exit ${String(result.code)}): ${redact(
        payload.outcome?.errorMessage ?? result.stderr ?? "unknown failure",
      )}`,
    );
  }
  const sourceJob = await readWorkspaceJobRecord(workspaceRoot, payload.job.id);
  if (sourceJob.sessionStateArchived !== true) {
    throw new Error("confined turn did not persist a selective Session archive");
  }
  const resumeResult = await runCompanion([
    "delegate", "--agent", options.agent, "--read-only", "--sandbox", "confined",
    "--resume-job", payload.job.id, "--json",
    ...(options.model ? ["--model", options.model] : []),
    "--", "Reply with only the private marker I asked you to remember in the previous turn. Do not use tools.",
  ]);
  const resumed = parseJson<Record<string, any>>(resumeResult.stdout, "resumed delegate");
  if (
    resumeResult.code !== 0 ||
    resumed.job?.status !== "completed" ||
    resumed.outcome?.finalText?.trim() !== resumeSecret
  ) {
    throw new Error(
      `confined resume failed (exit ${String(resumeResult.code)}): ${redact(
        resumed.outcome?.errorMessage ?? resumeResult.stderr ?? "unknown failure",
      )}`,
    );
  }
  const resumedJob = await readWorkspaceJobRecord(workspaceRoot, resumed.job.id);
  if (
    resumedJob.resumeJobId !== payload.job.id ||
    resumedJob.sessionStateArchived !== true
  ) {
    throw new Error("resumed Job did not remain bound to and re-archive its source Session");
  }
  turn = {
    jobId: payload.job.id,
    status: payload.job.status,
    model: payload.job.model,
    stopReason: payload.outcome.stopReason,
    sourceAcknowledged: true,
    sessionStateArchived: true,
    resumedJobId: resumed.job.id,
    restoredSecretMatched: true,
  };
}

const background = options.background
  ? await runBackgroundControl(options)
  : null;

const sandboxRootsAfter = await listSandboxJobRoots();
const leakedSandboxRoots = sandboxRootsAfter.filter(
  (entry) => !sandboxRootsBefore.includes(entry),
);
if (leakedSandboxRoots.length > 0) {
  throw new Error(
    `conformance left ${leakedSandboxRoots.length} confined Job root(s) behind`,
  );
}

console.log(JSON.stringify({
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  hostContext: process.env.CODEX_THREAD_ID
    ? "codex"
    : process.env.OPENCODE_SESSION_ID || process.env.OPENCODE_RUN_ID
      ? "opencode"
      : "terminal-or-explicit",
  agent: options.agent,
  expectation: options.expect,
  direct,
  doctor: {
    exitCode: doctorResult.code,
    selectedProfile: doctor.authority?.selectedProfile ?? null,
    profileRegistryId: doctor.authority?.profileRegistryId ?? null,
    confinedReady: confined?.ok === true,
    diagnostic: confined?.diagnostic ?? null,
  },
  turn,
  background,
}));
if (directFailed) process.exitCode = 1;

function parseOptions(args: string[]): Options {
  let agent: Options["agent"] | undefined;
  let expect: Options["expect"] = "ready";
  let model: string | undefined;
  let turn = false;
  let direct = false;
  let background = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--agent") {
      const value = args[++index];
      if (value !== "codex" && value !== "claude") {
        throw new Error("--agent must be codex or claude");
      }
      agent = value;
      continue;
    }
    if (argument === "--expect") {
      const value = args[++index];
      if (value !== "ready" && value !== "unsupported") {
        throw new Error("--expect must be ready or unsupported");
      }
      expect = value;
      continue;
    }
    if (argument === "--model") {
      model = args[++index];
      if (!model) throw new Error("--model requires a value");
      continue;
    }
    if (argument === "--turn") {
      turn = true;
      continue;
    }
    if (argument === "--direct") {
      direct = true;
      continue;
    }
    if (argument === "--background") {
      background = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!agent) {
    throw new Error(
      "usage: bun run conformance:job-authority -- --agent <codex|claude> [--expect ready|unsupported] [--direct] [--turn] [--background] [--model <id>]",
    );
  }
  if (expect === "unsupported" && (turn || direct || background)) {
    throw new Error("--expect unsupported cannot run direct or model-turn controls");
  }
  return { agent, expect, model, turn, direct, background };
}

async function runDirectProfileControl(
  cwd: string,
  input: Options,
): Promise<Record<string, unknown>> {
  const profiles = await loadProfiles(profilesPath());
  const profile = profiles.profiles[input.agent];
  if (!profile || profile.registryId !== input.agent) {
    throw new Error(
      `direct control requires configured '${input.agent}' Profile with matching registry identity`,
    );
  }
  const marker = `DIRECT_${input.agent.toUpperCase()}_${crypto.randomBytes(8).toString("hex")}`;
  const directEnvironment = await createDirectControlEnvironment(input.agent, profile.env);
  let agent: Awaited<ReturnType<typeof startAgent>> | undefined;
  let finalText = "";
  let stopReason: string | null = null;
  try {
    agent = await startAgent({
      binary: profile.binary,
      args: profile.args,
      env: directEnvironment.env,
      cwd,
      workspaceRoot: cwd,
      mode: "read-only",
      sandbox: "off",
      profileRegistryId: profile.registryId,
    });
    const session = await newSession(agent.connection, { cwd });
    await applySessionControls(agent.connection, {
      sessionId: session.sessionId,
      sessionState: session,
      model: input.model,
      profile: input.agent,
    });
    for await (const event of promptTurn(agent.connection, {
      sessionId: session.sessionId,
      prompt: `Reply with exactly ${marker} and do not use tools.`,
    })) {
      if (event.type === "update") {
        finalText += extractAgentMessageText(event.update as any);
      } else {
        stopReason = event.stopReason;
      }
    }
  } finally {
    if (agent) await agent.dispose();
    await fs.rm(directEnvironment.root, { recursive: true, force: true });
  }
  if (finalText.trim() !== marker) {
    throw new Error(
      `direct ${input.agent} control did not return its marker: ${redact(finalText)}`,
    );
  }
  return { ok: true, markerMatched: true, stopReason };
}

async function createDirectControlEnvironment(
  profile: Options["agent"],
  configuredEnv: Record<string, string>,
): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-direct-control-"));
  await fs.chmod(root, 0o700);
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const config = path.join(home, profile === "codex" ? ".codex" : ".claude");
  await Promise.all([
    fs.mkdir(config, { recursive: true, mode: 0o700 }),
    fs.mkdir(temp, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, ".cache"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, ".config"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, ".local", "share"), { recursive: true, mode: 0o700 }),
  ]);
  const hostEnv = { ...process.env, ...configuredEnv };
  const sourceConfig =
    profile === "codex"
      ? hostEnv.CODEX_HOME ?? path.join(os.homedir(), ".codex")
      : hostEnv.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const credential = profile === "codex" ? "auth.json" : ".credentials.json";
  try {
    await fs.copyFile(
      path.join(sourceConfig, credential),
      path.join(config, credential),
      fs.constants.COPYFILE_EXCL,
    );
    await fs.chmod(path.join(config, credential), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    root,
    env: {
      ...configuredEnv,
      HOME: home,
      TMPDIR: temp,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      ...(profile === "codex"
        ? { CODEX_HOME: config }
        : { CLAUDE_CONFIG_DIR: config }),
    },
  };
}

async function runBackgroundControl(input: Options): Promise<Record<string, unknown>> {
  const marker = `BACKGROUND_${input.agent.toUpperCase()}_${crypto.randomBytes(8).toString("hex")}`;
  const args = [
    "delegate", "--agent", input.agent, "--read-only", "--sandbox", "confined",
    "--background", "--fresh", "--json",
  ];
  if (input.model) args.push("--model", input.model);
  args.push("--", `Reply with exactly ${marker} and do not use tools.`);
  const queuedResult = await runCompanion(args);
  const queued = parseJson<Record<string, any>>(queuedResult.stdout, "background delegate");
  const jobId = queued.job?.id;
  if (queuedResult.code !== 0 || queued.job?.status !== "queued" || typeof jobId !== "string") {
    throw new Error("background delegate did not return a queued Job");
  }
  const statusResult = await runCompanion(["status", jobId, "--wait", "--json"]);
  const status = parseJson<Record<string, any>>(statusResult.stdout, "background status");
  const resultResult = await runCompanion(["result", jobId, "--json"]);
  const result = parseJson<Record<string, any>>(resultResult.stdout, "background result");
  if (
    statusResult.code !== 0 ||
    resultResult.code !== 0 ||
    status.job?.status !== "completed" ||
    result.outcome?.finalText?.trim() !== marker
  ) {
    throw new Error(
      `background ${input.agent} control failed: ${redact(
        result.outcome?.errorMessage ?? status.outcome?.errorMessage ?? "unknown failure",
      )}`,
    );
  }
  const record = await readWorkspaceJobRecord(workspaceRoot, jobId);
  if (record.sessionStateArchived !== true) {
    throw new Error("background control did not persist a selective Session archive");
  }
  return { jobId, queued: true, completed: true, resultMatched: true, sessionStateArchived: true };
}

function runCompanion(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [companionPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("conformance command timed out"));
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (overflow) {
        reject(new Error("conformance command output exceeded its bound"));
        return;
      }
      resolve({
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function redact(value: unknown): string {
  return String(value)
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(?:sk|sess|eyJ)[-_A-Za-z0-9.]{12,}/gu, "[REDACTED]")
    .replace(/[A-Za-z0-9_-]{64,}/gu, "[REDACTED]")
    .slice(0, 2_000);
}

function diagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  return redact(stderr ? `${message}: ${stderr}` : message);
}

async function listSandboxJobRoots(): Promise<string[]> {
  const entries = await fs.readdir("/tmp", { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("consult-srt-job-"))
    .map((entry) => entry.name)
    .sort();
}
