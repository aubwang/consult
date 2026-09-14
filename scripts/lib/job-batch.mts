import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceDir } from "./broker-endpoint.mts";
import { atomicWriteJson } from "./state.mts";

export const MAX_BATCH_JOBS = 8;
export interface JobBatch {
  schemaVersion: 1;
  id: string;
  jobIds: string[];
  submitted: boolean;
  error?: string;
}
export function newBatch(): JobBatch { return { schemaVersion: 1, id: `batch-${crypto.randomUUID()}`, jobIds: [], submitted: false }; }
function batchPath(workspaceRoot: string, id: string) {
  if (!/^batch-[0-9a-f-]{36}$/u.test(id)) throw new Error("invalid batch id");
  return path.join(workspaceDir(workspaceRoot), "batches", `${id}.json`);
}
export async function writeBatch(workspaceRoot: string, batch: JobBatch) {
  const file = batchPath(workspaceRoot, batch.id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, batch);
}
export async function readBatch(workspaceRoot: string, id: string): Promise<JobBatch> {
  const batch = JSON.parse(await fs.readFile(batchPath(workspaceRoot, id), "utf8"));
  if (batch.schemaVersion !== 1 || batch.id !== id || !Array.isArray(batch.jobIds) || batch.jobIds.length > MAX_BATCH_JOBS || batch.jobIds.some((id: unknown) => typeof id !== "string" || !/^job-[a-zA-Z0-9_-]+$/u.test(id)) || typeof batch.submitted !== "boolean") throw new Error("malformed batch record");
  return batch;
}
