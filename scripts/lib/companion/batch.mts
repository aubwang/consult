import fs from "node:fs/promises";
import { boolFlag, unsupportedFlagError, type ParsedArgs } from "../args.mts";
import { MAX_BATCH_JOBS, newBatch, writeBatch, type JobBatch } from "../job-batch.mts";
import { resolveWorkspaceRoot } from "../workspace.mts";
import { runDelegate, validateArgs } from "./delegate.mts";
import type { CommandResult } from "./output.mts";

const SHARED_FLAGS = ["agent", "model", "effort", "sandbox", "host", "host-session"];
const JOB_FLAGS = ["agent", "model", "effort", "sandbox", "label", "write", "isolated", "allow-fetch", "allow-exec", "include-diff", "base"];
export const MAX_BATCH_BYTES = 1024 * 1024;

export async function run(_subcommand: string, args: ParsedArgs): Promise<CommandResult> { return runBatch(args); }
export async function runBatch(args: ParsedArgs, deps: {
  readFile?: (file: string) => Promise<string>;
  resolveWorkspaceRoot?: typeof resolveWorkspaceRoot;
  delegate?: typeof runDelegate;
  writeBatch?: typeof writeBatch;
} = {}): Promise<CommandResult> {
  const unsupported = unsupportedFlagError(args.flags, [...SHARED_FLAGS, "json"]);
  if (unsupported) return error(unsupported);
  if (args.positional.length !== 1) return error("one batch JSON file is required");
  let requests: ParsedArgs[];
  try {
    const contents = await (deps.readFile ?? readBoundedFile)(args.positional[0]);
    if (Buffer.byteLength(contents) > MAX_BATCH_BYTES) throw new Error("batch file exceeds 1 MiB");
    requests = batchRequests(JSON.parse(contents), args.flags);
  } catch (failure) { return error(failure instanceof Error ? failure.message : String(failure)); }
  const root = await (deps.resolveWorkspaceRoot ?? resolveWorkspaceRoot)();
  const batch = newBatch();
  const save = deps.writeBatch ?? writeBatch;
  await save(root, batch);
  // Launch sequentially through Core: preflights can own process-global sandbox
  // state. The returned background Jobs run concurrently, at most eight here.
  for (const request of requests) {
    try {
      const result = await (deps.delegate ?? runDelegate)({ args: request, deps: { stdoutWrite: () => {}, stderrWrite: () => {} } });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Job submission failed");
      const payload = JSON.parse(result.stdout);
      if (typeof payload.job?.id !== "string") throw new Error("Job submission returned no id");
      batch.jobIds.push(payload.job.id);
      await save(root, batch);
    } catch (failure) {
      batch.error = `entry ${batch.jobIds.length + 1}: ${failure instanceof Error ? failure.message : String(failure)}`;
      await save(root, batch);
      return render(batch, args, 1);
    }
  }
  batch.submitted = true;
  await save(root, batch);
  return render(batch, args, 0);
}

export function batchRequests(value: unknown, shared: ParsedArgs["flags"]): ParsedArgs[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "jobs")) throw new Error("batch must be an object containing jobs");
  const jobs = (value as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_BATCH_JOBS) throw new Error(`batch requires 1-${MAX_BATCH_JOBS} Jobs`);
  return jobs.map((job, index) => {
    if (!job || typeof job !== "object" || Array.isArray(job) || typeof job.prompt !== "string" || !job.prompt.trim()) throw new Error(`entry ${index + 1}: prompt is required`);
    const flags: ParsedArgs["flags"] = { background: true, json: true };
    for (const name of SHARED_FLAGS) if (shared[name] !== undefined) flags[name] = shared[name];
    for (const [name, value] of Object.entries(job)) {
      if (name === "prompt") continue;
      if (!JOB_FLAGS.includes(name) || !["boolean", "string"].includes(typeof value)) throw new Error(`entry ${index + 1}: unsupported field ${name}`);
      const boolean = ["write", "isolated", "allow-fetch", "allow-exec", "include-diff"].includes(name);
      if (typeof value !== (boolean ? "boolean" : "string")) throw new Error(`entry ${index + 1}: ${name} requires a JSON ${boolean ? "boolean" : "string"}`);
      flags[name] = value as string | boolean;
    }
    if (flags.write === true && flags.isolated !== true) throw new Error(`entry ${index + 1}: batch writers require isolated: true`);
    const request: ParsedArgs = { positional: [job.prompt], flags };
    const validated = validateArgs(request);
    if (validated.error || validated.diagnostic) throw new Error(`entry ${index + 1}: ${validated.error ?? validated.diagnostic!.message}`);
    if (validated.mode === "write" && !validated.isolated) throw new Error(`entry ${index + 1}: batch writers require isolated: true`);
    return request;
  });
}

async function readBoundedFile(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(MAX_BATCH_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset > MAX_BATCH_BYTES) throw new Error("batch file exceeds 1 MiB");
    return bytes.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}
function error(message: string): CommandResult { return { exitCode: 2, stdout: "", stderr: `${message}\n` }; }
function render(batch: JobBatch, args: ParsedArgs, exitCode: number): CommandResult {
  return { exitCode, stdout: boolFlag(args.flags.json) ? `${JSON.stringify(batch)}\n` : `${batch.id}: ${batch.jobIds.length} Jobs submitted\n${batch.jobIds.join("\n")}\nconsult wait --batch ${batch.id} --watch --summary\n`, stderr: batch.error ? `${batch.error}; submitted Jobs remain tracked in ${batch.id}\n` : "" };
}
