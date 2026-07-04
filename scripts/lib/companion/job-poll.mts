import { isFinalStatus } from "../job-records.mts";
import type { JobRecord } from "../job-records.mts";

export interface PollUntilFinalOptions {
  readRecord: () => Promise<JobRecord>;
  onRecord?: (record: JobRecord) => Promise<void>;
  maxWaitMs?: number;
  poll?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  timeoutCode: string;
  timeoutMessage: string;
}

interface PollTimeoutError extends Error {
  code: string;
}

export async function pollUntilFinalRecord({
  readRecord,
  onRecord,
  maxWaitMs,
  poll,
  nowMs,
  timeoutCode,
  timeoutMessage,
}: PollUntilFinalOptions): Promise<JobRecord> {
  const pollFn = poll ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = nowMs ?? (() => Date.now());
  const deadline = now() + (maxWaitMs ?? 30 * 60 * 1000);
  let record = await readRecord();
  await onRecord?.(record);
  while (!isFinalStatus(record.status)) {
    if (now() >= deadline) {
      const error = new Error(timeoutMessage) as PollTimeoutError;
      error.code = timeoutCode;
      throw error;
    }
    await pollFn(200);
    record = await readRecord();
    await onRecord?.(record);
  }
  return record;
}
