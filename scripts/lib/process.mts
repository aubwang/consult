export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

// A SIGKILLed process group is not gone until every member has been reaped, and
// real Profile groups are not one process: an ACP shim plus a vendored agent
// binary and its children clear in roughly a second on a loaded host, against
// the 25ms poll below. The previous one-second grace sat on top of that
// observed latency, so teardown failed or succeeded by coin flip. Prefer a
// generous ceiling: the poll returns as soon as the target is gone, so the
// larger value costs nothing until something is genuinely stuck.
export const DEFAULT_FORCE_KILL_GRACE_MS = 5000;

export const FORCE_KILL_GRACE_ENV = "CONSULT_FORCE_KILL_GRACE_MS";

export function resolveForceKillGraceMs(
  optionValue?: number,
  envValue: string | undefined = process.env[FORCE_KILL_GRACE_ENV],
): number {
  // An exported-but-empty variable means "unset", not "no grace at all": Number("")
  // is 0, which would restore exactly the impatience this default exists to avoid.
  const configured = envValue?.trim() ? envValue : undefined;
  const raw = optionValue ?? configured ?? DEFAULT_FORCE_KILL_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${FORCE_KILL_GRACE_ENV}: ${raw}`);
  }
  return parsed;
}

export function pidIsAlive(pid: number): boolean {
  return processTargetIsAlive(pid);
}

export function processGroupIsAlive(processGroupId: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  return processTargetIsAlive(-processGroupId);
}

function processTargetIsAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function terminateProcessTree(
  pid: number,
  { signal = "SIGTERM", timeoutMs = 2000 }: TerminateProcessTreeOptions = {},
): Promise<void> {
  if (processGroupIsAlive(pid)) {
    await terminateProcessGroup(pid, { signal, timeoutMs });
    return;
  }
  if (!pidIsAlive(pid)) {
    return;
  }
  signalPid(pid, signal);
  await waitForTargetExit(() => pidIsAlive(pid), () => signalPid(pid, "SIGKILL"), timeoutMs);
}

export async function terminateProcessGroup(
  processGroupId: number,
  { signal = "SIGTERM", timeoutMs = 2000 }: TerminateProcessTreeOptions = {},
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  if (!processGroupIsAlive(processGroupId)) {
    return;
  }
  signalProcessGroup(processGroupId, signal);
  await waitForTargetExit(
    () => processGroupIsAlive(processGroupId),
    () => signalProcessGroup(processGroupId, "SIGKILL"),
    timeoutMs,
  );
}

interface WaitForTargetExitDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  forceKillGraceMs?: number;
}

export async function waitForTargetExit(
  isAlive: () => boolean,
  forceKill: () => void,
  timeoutMs: number,
  dependencies: WaitForTargetExitDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  while (isAlive()) {
    if (now() >= deadline) {
      forceKill();
      break;
    }
    await sleep(25);
  }
  const killDeadline = now() + resolveForceKillGraceMs(dependencies.forceKillGraceMs);
  while (isAlive() && now() < killDeadline) {
    await sleep(25);
  }
  if (isAlive()) {
    throw new Error("process target remained alive after SIGKILL");
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
}
