// Internal launch guard, before the filesystem/network sandbox starts. It
// verifies kernel enforcement rather than trusting accepted systemd properties.
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { EXECUTION_LIMITS } from "./lib/execution-limits.mts";
const group = (await fs.readFile("/proc/self/cgroup", "utf8")).trim().match(/^0::(.+)$/u)?.[1];
if (!group || !/\/consult-exec-[0-9a-f-]+\.scope$/u.test(group)) throw new Error("missing execute cgroup");
const root = path.join("/sys/fs/cgroup", group);
const read = async (file: string) => (await fs.readFile(path.join(root, file), "utf8")).trim();
const [memory, swap, pids, cpu] = await Promise.all([read("memory.max"), read("memory.swap.max"), read("pids.max"), read("cpu.max")]);
const [quota, period] = cpu.split(" ").map(Number);
if (Number(memory) !== EXECUTION_LIMITS.memoryBytes || Number(swap) !== 0 || Number(pids) !== EXECUTION_LIMITS.processes || !Number.isFinite(quota) || quota / period > EXECUTION_LIMITS.cpuPercent / 100) throw new Error("execute resource limits were not enforced");
const [binary, ...args] = process.argv.slice(2);
if (!binary) throw new Error("missing execute target");
const env = { ...process.env };
delete env.XDG_RUNTIME_DIR;
delete env.DBUS_SESSION_BUS_ADDRESS;
const child = spawn("/usr/bin/prlimit", [`--fsize=${EXECUTION_LIMITS.fileBytes}:${EXECUTION_LIMITS.fileBytes}`, "--core=0:0", "--", binary, ...args], { env, stdio: "inherit" });
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
