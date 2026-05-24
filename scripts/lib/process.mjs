export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    if (error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function terminateProcessTree(pid, { signal = "SIGTERM", timeoutMs = 2000 } = {}) {
  if (!pidIsAlive(pid)) {
    return;
  }
  signalPidOrGroup(pid, signal);
  await waitForExit(pid, timeoutMs);
}

async function waitForExit(pid, timeoutMs) {
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

function signalPidOrGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if (fallbackError.code === "ESRCH") {
        return;
      }
      throw fallbackError;
    }
  }
}
