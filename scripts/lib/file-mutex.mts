import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pidMatchesStartTime, processStartTime } from "./process-identity.mts";

interface Claim {
  pid: number;
  startTime: string;
  ticket: number;
}

let ownStartTime: Promise<string | null> | undefined;

/**
 * Local-filesystem mutual exclusion using Lamport's bakery algorithm:
 * https://lamport.azurewebsites.net/pubs/bakery.pdf
 *
 * Each acquisition owns a unique claim, first choosing (ticket 0), then waiting
 * in ticket/UUID order. Only its owner changes that claim. A dead owner's claim
 * can be removed without racing a replacement owner at the same pathname.
 * Live owners are never evicted by age; timeout fails the waiting operation.
 * Requires coherent local directory reads and atomic same-directory rename.
 */
export async function withFileMutex<T>(
  directory: string, action: () => Promise<T>, timeoutMs = 30_000,
): Promise<T> {
  ownStartTime ??= processStartTime();
  const startTime = await ownStartTime;
  if (!startTime) throw new Error("Cannot identify process for Job state lock");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${randomUUID()}.claim`;
  const file = path.join(directory, id);
  const staging = `${file}.tmp`;
  const claim: Claim = { pid: process.pid, startTime, ticket: 0 };
  const publish = async () => {
    await fs.writeFile(staging, JSON.stringify(claim), { mode: 0o600 });
    await fs.rename(staging, file);
  };
  const deadline = Date.now() + timeoutMs;
  try {
    await publish();
    const peers = await liveClaims(directory);
    claim.ticket = 1 + Math.max(0, ...peers.map((peer) => peer.claim.ticket));
    if (!Number.isSafeInteger(claim.ticket)) throw new Error("Job state lock ticket overflow");
    await publish();
    while (true) {
      const blocked = (await liveClaims(directory)).some((peer) => peer.id !== id && (
        peer.claim.ticket === 0 || peer.claim.ticket < claim.ticket ||
        (peer.claim.ticket === claim.ticket && peer.id < id)
      ));
      if (!blocked) return await action();
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Job state lock: ${directory}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await fs.unlink(file).catch(ignoreMissing);
    await fs.unlink(staging).catch(ignoreMissing);
  }
}

async function liveClaims(directory: string): Promise<Array<{ id: string; claim: Claim }>> {
  const claims: Array<{ id: string; claim: Claim }> = [];
  for (const id of await fs.readdir(directory)) {
    if (!id.endsWith(".claim")) continue;
    const file = path.join(directory, id);
    let claim: Claim;
    try {
      claim = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!claim || !Number.isInteger(claim.pid) || claim.pid < 1 ||
        typeof claim.startTime !== "string" || !Number.isSafeInteger(claim.ticket) || claim.ticket < 0) {
      throw new Error(`Malformed Job state lock: ${file}`);
    }
    if (await pidMatchesStartTime(claim.pid, claim.startTime)) {
      claims.push({ id, claim });
    } else {
      await fs.unlink(file).catch(ignoreMissing);
    }
  }
  return claims;
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}
