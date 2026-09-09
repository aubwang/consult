import fs from "node:fs/promises";
import path from "node:path";
import { boolFlag, stringFlag, unsupportedFlagError, type ParsedArgs } from "../args.mts";
import { jobsDir, jobArtifactsDir } from "../broker-endpoint.mts";
import { withFileMutex } from "../file-mutex.mts";
import { isolatedTransactionRoot } from "../isolated-workspace.mts";
import { isFinalStatus, jobLogPath, jobRecordPath, listWorkspaceJobRecords, type JobRecord } from "../job-records.mts";
import { safeSegment } from "../path-segments.mts";
import { pidIsAlive } from "../process.mts";
import { pidMatchesStartTime } from "../process-identity.mts";
import { resolveWorkspaceRoot } from "../workspace.mts";
import type { CliResult } from "./job-record-errors.mts";

export async function run(_command: string, args: ParsedArgs): Promise<CliResult> {
  const unsupported = unsupportedFlagError(args.flags, ["older-than", "apply", "json"]);
  if (unsupported) return { exitCode: 2, stdout: "", stderr: `${unsupported}\n` };
  const raw = stringFlag(args.flags["older-than"]) ?? "30d";
  if (!/^\d+d$/u.test(raw) || Number(raw.slice(0, -1)) < 1 || args.positional.length) {
    return { exitCode: 2, stdout: "", stderr: "usage: consult clean [--older-than 30d] [--apply] [--json]\n" };
  }
  const workspaceRoot = await resolveWorkspaceRoot();
  try {
    const result = await cleanHistory(workspaceRoot, {
      olderThanDays: Number(raw.slice(0, -1)), apply: boolFlag(args.flags.apply),
    });
    return { exitCode: 0, stdout: boolFlag(args.flags.json) ? `${JSON.stringify(result)}\n`
      : `${result.apply ? "Removed" : "Would remove"} ${result.jobIds.length} expired Job(s)${result.apply ? "" : "; rerun with --apply to remove them"}\n${result.jobIds.map((id) => `${id}\n`).join("")}`, stderr: "" };
  } catch (error) { return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` }; }
}

export async function cleanHistory(workspaceRoot: string, {
  olderThanDays = 30, apply = false, now = Date.now(),
}: { olderThanDays?: number; apply?: boolean; now?: number } = {}): Promise<{ apply: boolean; jobIds: string[] }> {
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1) throw new Error("Retention must be at least one whole day");
  const dir = jobsDir(workspaceRoot);
  return withFileMutex(path.join(dir, ".locks", "history"), async () => {
    const records = await listWorkspaceJobRecords(workspaceRoot);
    const candidates = new Set<string>();
    for (const record of records) {
      if (!record.jobId || !isFinalStatus(record.status) || record.recoveryWorkspace) continue;
      const completed = Date.parse(record.completedAt ?? "");
      if (!Number.isFinite(completed) || completed >= now - olderThanDays * 86400000) continue;
      if (await ownsLiveProcess(record)) continue;
      const worktree = path.join(isolatedTransactionRoot(workspaceRoot, record.jobId), "worktree");
      if (await fs.lstat(worktree).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) continue;
      candidates.add(record.jobId);
    }
    // Retain the transitive dependencies of every record that will remain.
    const byId = new Map(records.map((record) => [record.jobId, record]));
    const retained = records.filter((record) => !record.jobId || !candidates.has(record.jobId));
    for (let index = 0; index < retained.length; index++) {
      const record = retained[index];
      for (const id of [record.parentJobId, record.resumeJobId, record.reviewOfJobId, ...(record.afterJobIds ?? [])]) {
        if (id && candidates.delete(id)) {
          const dependency = byId.get(id);
          if (dependency) retained.push(dependency);
        }
      }
    }
    const jobIds = [...candidates].sort();
    if (apply) {
      await fs.mkdir(path.join(dir, ".pruned"), { recursive: true, mode: 0o700 });
      for (const id of jobIds) {
        // Small tombstones prevent stale writers or a racing new dependency
        // from resurrecting a record after its artifacts have been removed.
        await fs.writeFile(path.join(dir, ".pruned", safeSegment(id)), "", { mode: 0o600 });
        await fs.rm(jobArtifactsDir(workspaceRoot, id), { recursive: true, force: true });
        await fs.rm(isolatedTransactionRoot(workspaceRoot, id), { recursive: true, force: true });
        await fs.rm(jobLogPath(workspaceRoot, id), { force: true });
        await fs.rm(jobRecordPath(workspaceRoot, id), { force: true });
      }
    }
    return { apply, jobIds };
  });
}

async function ownsLiveProcess(record: JobRecord): Promise<boolean> {
  for (const [pid, identity] of [[record.workerPid, record.workerStartTime], [record.runnerPid, record.runnerStartTime]] as const) {
    if (pid && pidIsAlive(pid) && (!identity || await pidMatchesStartTime(pid, identity))) return true;
  }
  return false;
}
