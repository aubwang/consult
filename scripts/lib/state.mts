import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isRecord } from "./objects.mts";
import { safeSegment } from "./path-segments.mts";

export async function readJobRecord(
  jobsDir: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const filePath = path.join(jobsDir, `${safeSegment(jobId)}.json`);
  const record = await readJsonFile(filePath);
  if (record.jobId !== jobId) {
    const error = new Error(`Job record not found: ${jobId}`) as JobRecordError;
    error.code = "ENOENT";
    error.path = filePath;
    throw error;
  }
  return record;
}

export async function listJobRecords(jobsDir: string): Promise<Record<string, unknown>[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(jobsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    records.push(await readJsonFile(path.join(jobsDir, entry)));
  }
  records.sort((left, right) =>
    String(right.submittedAt ?? "").localeCompare(String(left.submittedAt ?? "")),
  );
  return records;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw malformedJobRecord(filePath);
    }
    throw error;
  }
  if (!isRecord(value)) {
    throw malformedJobRecord(filePath);
  }
  return value;
}

export interface JobRecordError extends Error {
  code?: string;
  path?: string;
}

function malformedJobRecord(filePath: string): JobRecordError {
  const malformed: JobRecordError = new Error(`Job record is malformed: ${filePath}`);
  malformed.code = "JOB_RECORD_MALFORMED";
  malformed.path = filePath;
  return malformed;
}

export async function atomicWriteJson(destPath: string, value: unknown): Promise<void> {
  const parentDir = path.dirname(destPath);
  const tempPath = path.join(
    parentDir,
    `.${path.basename(destPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(JSON.stringify(value), "utf8");

  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await fs.open(tempPath, "wx", 0o600);
    await fileHandle.writeFile(bytes);
    await fileHandle.sync();
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }

  try {
    await fs.rename(tempPath, destPath);
    await fsyncDirectory(parentDir);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  let dirHandle: FileHandle | undefined;
  try {
    dirHandle = await fs.open(dirPath, "r");
    await dirHandle.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EPERM"].includes(
        (error as NodeJS.ErrnoException | undefined)?.code as string,
      )
    ) {
      throw error;
    }
  } finally {
    if (dirHandle) {
      await dirHandle.close();
    }
  }
}
