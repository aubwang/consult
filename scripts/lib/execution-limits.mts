import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentLaunch } from "./process-sandbox.mts";

export const EXECUTION_LIMITS = Object.freeze({ memoryBytes: 4 * 1024 ** 3, processes: 256, cpuPercent: 200, fileBytes: 64 * 1024 ** 2, wallClockSeconds: 1800 });
const exec = promisify(execFile);
const guard = fileURLToPath(new URL(import.meta.url.endsWith(".mts") ? "../consult-exec.mts" : "../consult-exec.mjs", import.meta.url));

export function boundedExecutionLaunch(launch: AgentLaunch, hostEnv: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "linux") throw new Error("bounded execute authority currently requires Linux with a systemd user manager and cgroup v2");
  const unit = `consult-exec-${crypto.randomUUID()}.scope`;
  const env = { ...launch.env, XDG_RUNTIME_DIR: hostEnv.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: hostEnv.DBUS_SESSION_BUS_ADDRESS };
  const args = ["--user", "--scope", "--quiet", `--unit=${unit}`,
    `--property=MemoryMax=${EXECUTION_LIMITS.memoryBytes}`, "--property=MemorySwapMax=0", "--property=TimeoutStopSec=2s",
    `--property=TasksMax=${EXECUTION_LIMITS.processes}`, `--property=CPUQuota=${EXECUTION_LIMITS.cpuPercent}%`,
    `--property=RuntimeMaxSec=${EXECUTION_LIMITS.wallClockSeconds}`,
    "--", process.execPath, guard, launch.binary, ...launch.args];
  let stopped = false;
  return {
    launch: { ...launch, binary: "/usr/bin/systemd-run", args, env },
    async terminate() {
      if (stopped) return;
      // systemd owns the whole cgroup, including descendants that created a new
      // process group. Do this before Session archival and worktree cleanup.
      const state = await exec("/usr/bin/systemctl", ["--user", "show", unit, "--property=LoadState", "--value"], { env: hostEnv, timeout: 5000, maxBuffer: 4096 });
      if (state.stdout.trim() !== "not-found") await exec("/usr/bin/systemctl", ["--user", "stop", unit], { env: hostEnv, timeout: 10_000, maxBuffer: 4096 });
      const after = await exec("/usr/bin/systemctl", ["--user", "show", unit, "--property=ActiveState", "--value"], { env: hostEnv, timeout: 5000, maxBuffer: 4096 });
      if (!["inactive", "failed"].includes(after.stdout.trim())) throw new Error("execute cgroup did not stop; preserving Job workspace");
      stopped = true;
    },
  };
}

export async function probeExecutionLimits(): Promise<void> {
  const bounded = boundedExecutionLaunch({ binary: "/usr/bin/true", args: [], cwd: process.cwd(), env: {} });
  try {
    await exec(bounded.launch.binary, bounded.launch.args, { cwd: bounded.launch.cwd, env: bounded.launch.env, timeout: 10_000, maxBuffer: 4096 });
  } catch {
    throw new Error("execute confinement requires a working systemd user manager, cgroup v2 memory/pids/cpu controllers, and prlimit; no Job was launched");
  } finally { await bounded.terminate(); }
}
