import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function readJobRecord(jobsDir, jobId) {
  return await readJsonFile(path.join(jobsDir, `${jobId}.json`));
}

export async function listJobRecords(jobsDir) {
  let entries;
  try {
    entries = await fs.readdir(jobsDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = [];
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

async function readJsonFile(filePath) {
  let value;
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

function malformedJobRecord(filePath) {
  const malformed = new Error(`Job record is malformed: ${filePath}`);
  malformed.code = "JOB_RECORD_MALFORMED";
  malformed.path = filePath;
  return malformed;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function atomicWriteJson(destPath, value) {
  const parentDir = path.dirname(destPath);
  const tempPath = path.join(
    parentDir,
    `.${path.basename(destPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(JSON.stringify(value), "utf8");

  let fileHandle;
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

async function fsyncDirectory(dirPath) {
  let dirHandle;
  try {
    dirHandle = await fs.open(dirPath, "r");
    await dirHandle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (dirHandle) {
      await dirHandle.close();
    }
  }
}
