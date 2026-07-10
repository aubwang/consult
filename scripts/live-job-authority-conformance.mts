import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  listWorkspaceJobRecords,
  readWorkspaceJobRecord,
} from "./lib/job-records.mts";
import { resolveWorkspaceRoot } from "./lib/workspace.mts";

const companionPath = fileURLToPath(new URL("./consult-companion.mts", import.meta.url));
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

interface Options {
  agent: "codex" | "claude";
  expect: "ready" | "unsupported";
  model?: string;
  turn: boolean;
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
  const expectedText = `CONFINED_${options.agent.toUpperCase()}_OK`;
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
  args.push("--", `Reply with exactly ${expectedText} and do not use tools.`);
  const result = await runCompanion(args);
  const payload = parseJson<Record<string, any>>(result.stdout, "delegate");
  if (
    result.code !== 0 ||
    payload.job?.status !== "completed" ||
    payload.outcome?.finalText?.trim() !== expectedText
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
    "--", `Reply with the exact marker from the previous turn: ${expectedText}`,
  ]);
  const resumed = parseJson<Record<string, any>>(resumeResult.stdout, "resumed delegate");
  if (
    resumeResult.code !== 0 ||
    resumed.job?.status !== "completed" ||
    resumed.outcome?.finalText?.trim() !== expectedText
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
    finalTextMatched: true,
    sessionStateArchived: true,
    resumedJobId: resumed.job.id,
    resumeFinalTextMatched: true,
  };
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
  doctor: {
    exitCode: doctorResult.code,
    selectedProfile: doctor.authority?.selectedProfile ?? null,
    profileRegistryId: doctor.authority?.profileRegistryId ?? null,
    confinedReady: confined?.ok === true,
    diagnostic: confined?.diagnostic ?? null,
  },
  turn,
}));

function parseOptions(args: string[]): Options {
  let agent: Options["agent"] | undefined;
  let expect: Options["expect"] = "ready";
  let model: string | undefined;
  let turn = false;
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
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!agent) {
    throw new Error(
      "usage: bun run conformance:job-authority -- --agent <codex|claude> [--expect ready|unsupported] [--turn] [--model <id>]",
    );
  }
  return { agent, expect, model, turn };
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
