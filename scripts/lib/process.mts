export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
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
  const killDeadline = now() + (dependencies.forceKillGraceMs ?? 1000);
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
