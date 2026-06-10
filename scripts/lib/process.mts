export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
  if (!pidIsAlive(pid)) {
    return;
  }
  signalPidOrGroup(pid, signal);
  await waitForExit(pid, timeoutMs);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) {
      signalPidOrGroup(pid, "SIGKILL");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const killDeadline = Date.now() + 1000;
  while (pidIsAlive(pid) && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function signalPidOrGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw fallbackError;
    }
  }
}
