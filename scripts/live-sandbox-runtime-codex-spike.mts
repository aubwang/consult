import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

interface ProbeCheck {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

interface SpikeReport {
  schemaVersion: 1;
  runtime: { package: "@anthropic-ai/sandbox-runtime"; version: string };
  target: {
    profile: "codex";
    context: "codex-host" | "standalone-control";
    platform: NodeJS.Platform;
    arch: string;
    release: string;
  };
  checks: ProbeCheck[];
  decision: "keep" | "kill" | "inconclusive";
  decisionBasis: string;
}

const RUNTIME_VERSION = "0.0.64";

async function main(): Promise<void> {
  const checks: ProbeCheck[] = [];
  const dependencies = SandboxManager.checkDependencies();
  checks.push({
    id: "runtime-preflight",
    status:
      SandboxManager.isSupportedPlatform() && dependencies.errors.length === 0 ? "pass" : "fail",
    detail: JSON.stringify({
      supported: SandboxManager.isSupportedPlatform(),
      dependencies,
    }),
  });

  if (process.platform !== "darwin") {
    checks.push({
      id: "macos-nested-seatbelt",
      status: "skip",
      detail: `requires native macOS; current platform is ${process.platform}`,
    });
    printReport(checks);
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-srt-codex-spike-"));
  const nativeNesting = await run(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)\n(allow default)",
      "/usr/bin/true",
    ],
    { cwd: root, env: process.env },
  );
  checks.push({
    id: "native-nested-seatbelt",
    status: nativeNesting.code === 0 ? "pass" : "fail",
    detail: JSON.stringify(nativeNesting),
  });

  let initialized = false;
  let proxyPort: number | undefined;
  try {
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    };

    await SandboxManager.initialize(config);
    initialized = true;
    proxyPort = SandboxManager.getProxyPort();
    checks.push({
      id: "runtime-initialize",
      status: "pass",
      detail: JSON.stringify({ proxyStarted: proxyPort !== undefined }),
    });
  } catch (error) {
    checks.push({
      id: "runtime-initialize",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (initialized) {
    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv("/usr/bin/true", "/bin/zsh");
      const result = await run(wrapped.argv, { cwd: root, env: wrapped.env });
      checks.push({
        id: "runtime-wrapped-launch",
        status: result.code === 0 ? "pass" : "fail",
        detail: JSON.stringify(result),
      });
    } catch (error) {
      checks.push({
        id: "runtime-wrapped-launch",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      id: "runtime-wrapped-launch",
      status: "skip",
      detail: "runtime initialization failed before Profile launch",
    });
  }

  try {
    await SandboxManager.reset();
    const proxyClosed = proxyPort === undefined || !(await canConnect(proxyPort));
    checks.push({
      id: "runtime-proxy-cleanup",
      status: proxyClosed ? "pass" : "fail",
      detail: proxyPort === undefined ? "no proxy listener was established" : "proxy listener closed",
    });
  } catch (error) {
    checks.push({
      id: "runtime-proxy-cleanup",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  printReport(checks);
}

function printReport(checks: ProbeCheck[]): void {
  const context = process.env.CODEX_SANDBOX ? "codex-host" : "standalone-control";
  const requiredFailures = checks.filter(
    (check) =>
      ["runtime-preflight", "native-nested-seatbelt", "runtime-initialize", "runtime-wrapped-launch"].includes(
        check.id,
      ) && check.status === "fail",
  );
  const decision = context === "codex-host" && requiredFailures.length > 0 ? "kill" : "inconclusive";
  const decisionBasis =
    decision === "kill"
      ? `Kill for the macOS Codex Host path: ${requiredFailures.map((check) => check.id).join(", ")} failed before Codex model transport.`
      : context === "standalone-control"
        ? "Standalone control only; success here does not establish compatibility with a sandboxed Codex Host."
        : "The initial gates passed; broader Codex conformance evidence is still required.";
  const report: SpikeReport = {
    schemaVersion: 1,
    runtime: { package: "@anthropic-ai/sandbox-runtime", version: RUNTIME_VERSION },
    target: {
      profile: "codex",
      context,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    checks,
    decision,
    decisionBasis,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function run(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

await main();
