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

async function waitForTargetExit(
  isAlive: () => boolean,
  forceKill: () => void,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive()) {
    if (Date.now() >= deadline) {
      forceKill();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const killDeadline = Date.now() + 1000;
  while (isAlive() && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
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
