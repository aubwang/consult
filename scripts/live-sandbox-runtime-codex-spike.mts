import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
  schemaVersion: 2;
  runtime: { package: "@anthropic-ai/sandbox-runtime"; version: string };
  target: {
    profile: "codex";
    context:
      | "codex-host-confined"
      | "codex-host-confined-network-disabled"
      | "codex-host-confined-full-network"
      | "codex-host-unrestricted"
      | "standalone-control"
      | "unknown";
    contextDeclared: boolean;
    contextEvidence: string;
    kernelPolicyEvidence: string;
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
  const dependencyReady =
    SandboxManager.isSupportedPlatform() &&
    dependencies.errors.length === 0 &&
    dependencies.warnings.length === 0;
  checks.push({
    id: "runtime-preflight",
    status: dependencyReady ? "pass" : "fail",
    detail: JSON.stringify({
      supported: SandboxManager.isSupportedPlatform(),
      dependencies,
    }),
  });

  if (process.platform !== "darwin" && process.platform !== "linux") {
    checks.push({
      id: "native-nesting",
      status: "skip",
      detail: `Consult confinement is scoped to native macOS and Linux; current platform is ${process.platform}`,
    });
    printReport(checks);
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-srt-codex-spike-"));
  if (process.platform === "darwin") {
    const seatbelt = await run(
      [
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1)\n(allow default)",
        "/usr/bin/true",
      ],
      { cwd: root, env: process.env },
    );
    checks.push({
      id: "native-seatbelt",
      status: seatbelt.code === 0 ? "pass" : "fail",
      detail: JSON.stringify(seatbelt),
    });
  } else {
    await runLinuxNativeChecks(root, checks);
  }

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
      const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
      const wrapped = await SandboxManager.wrapWithSandboxArgv("/usr/bin/true", shell);
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
    } finally {
      SandboxManager.cleanupAfterCommand();
    }
  } else {
    checks.push({
      id: "runtime-wrapped-launch",
      status: "skip",
      detail: "runtime initialization failed before wrapped command launch",
    });
  }

  try {
    await SandboxManager.reset();
    const proxyClosed = proxyPort === undefined || !(await canConnect(proxyPort));
    checks.push({
      id: "runtime-proxy-cleanup",
      status: proxyClosed ? "pass" : "fail",
      detail:
        proxyPort === undefined
          ? "no proxy listener was established"
          : proxyClosed
            ? "proxy listener closed"
            : "proxy listener remained reachable after reset",
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
  const { context, contextDeclared, evidence } = detectContext();
  const preflight = checks.find((check) => check.id === "runtime-preflight");
  const nativeChecks =
    process.platform === "darwin"
      ? checks.filter((check) => check.id === "native-seatbelt")
      : checks.filter((check) => check.id.startsWith("native-linux-"));
  const nativeReady =
    nativeChecks.length > 0 && nativeChecks.every((check) => check.status === "pass");
  const seatbelt = checks.find((check) => check.id === "native-seatbelt");
  const initialization = checks.find((check) => check.id === "runtime-initialize");
  const wrappedLaunch = checks.find((check) => check.id === "runtime-wrapped-launch");
  const cleanup = checks.find((check) => check.id === "runtime-proxy-cleanup");
  const observedMacosCodexHostFailure =
    process.platform === "darwin" &&
    context === "codex-host-confined" &&
    preflight?.status === "pass" &&
    seatbelt?.status === "fail" &&
    seatbelt.detail.includes('\"code\":71') &&
    seatbelt.detail.includes("sandbox_apply: Operation not permitted") &&
    initialization?.status === "fail" &&
    initialization.detail.includes("EPERM");
  const technicalCompatibilityPassed =
    preflight?.status === "pass" &&
    nativeReady &&
    initialization?.status === "pass" &&
    wrappedLaunch?.status === "pass" &&
    cleanup?.status === "pass";
  const compatibilityPassed =
    contextDeclared && context !== "unknown" && technicalCompatibilityPassed;
  const knownContextFailure =
    contextDeclared && context !== "unknown" && !technicalCompatibilityPassed;
  const decision = observedMacosCodexHostFailure
    ? "kill"
    : compatibilityPassed
      ? "keep"
      : knownContextFailure
        ? "kill"
        : "inconclusive";
  const decisionBasis =
    observedMacosCodexHostFailure
      ? "Kill for the marked confined macOS Codex Host path: nested Seatbelt exited 71 and runtime proxy initialization failed with EPERM before Codex model transport."
      : knownContextFailure
        ? "Kill this runtime/context combination: one or more required native or runtime compatibility gates failed, so Consult must not integrate it or fall back to ambient authority implicitly."
        : decision === "keep"
          ? "Keep this runtime/context combination for deeper policy and Profile conformance. Compatibility gates passed; this is not evidence that filesystem policy, model transport, egress filtering, or process-tree cleanup meets Consult's product requirements."
          : technicalCompatibilityPassed && (!contextDeclared || context === "unknown")
            ? "Compatibility gates passed, but the Host confinement context was not explicitly declared; the result is inconclusive rather than attributing success to the wrong context."
            : "Compatibility gates did not all pass, and the observed failures did not match the specific confined macOS Codex Host kill signature.";
  const report: SpikeReport = {
    schemaVersion: 2,
    runtime: { package: "@anthropic-ai/sandbox-runtime", version: RUNTIME_VERSION },
    target: {
      profile: "codex",
      context,
      contextDeclared,
      contextEvidence: evidence,
      kernelPolicyEvidence: kernelPolicyEvidence(),
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

function kernelPolicyEvidence(): string {
  if (process.platform !== "linux") {
    return "not collected on this platform";
  }
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const fields = ["NoNewPrivs", "Seccomp", "Seccomp_filters"].flatMap((field) => {
      const value = status.match(new RegExp(`^${field}:\\s+(.+)$`, "m"))?.[1]?.trim();
      return value ? [`${field}=${value}`] : [];
    });
    let appArmor = "unknown";
    try {
      appArmor = readFileSync("/proc/self/attr/current", "utf8").trim();
    } catch {
      // The other kernel fields still provide useful evidence.
    }
    return [...fields, `AppArmor=${appArmor}`].join(", ");
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function detectContext(): {
  context: SpikeReport["target"]["context"];
  contextDeclared: boolean;
  evidence: string;
} {
  const declared = process.env.CONSULT_SPIKE_HOST_CONTEXT;
  const allowed = new Set<SpikeReport["target"]["context"]>([
    "codex-host-confined",
    "codex-host-confined-network-disabled",
    "codex-host-confined-full-network",
    "codex-host-unrestricted",
    "standalone-control",
    "unknown",
  ]);
  if (declared && allowed.has(declared as SpikeReport["target"]["context"])) {
    return {
      context: declared as SpikeReport["target"]["context"],
      contextDeclared: true,
      evidence:
        "CONSULT_SPIKE_HOST_CONTEXT declaration; informational label only, not proof of kernel policy",
    };
  }
  if (process.env.CODEX_SANDBOX) {
    return {
      context: "codex-host-confined",
      contextDeclared: false,
      evidence: "CODEX_SANDBOX marker present; informational label only, not proof of kernel policy",
    };
  }
  if (process.platform === "linux") {
    try {
      const ancestorNames = linuxAncestorNames(process.ppid);
      if (ancestorNames.includes("codex")) {
        return {
          context: "unknown",
          contextDeclared: false,
          evidence:
            "process ancestry includes codex but no Host confinement context was declared; marker absence is not evidence of unrestricted execution",
        };
      }
    } catch {
      // Fall through to an unknown context rather than treating missing evidence as proof.
    }
  }
  return {
    context: "unknown",
    contextDeclared: false,
    evidence:
      "no explicit context declaration or recognized Host marker; native probes are the only confinement evidence",
  };
}

async function runLinuxNativeChecks(root: string, checks: ProbeCheck[]): Promise<void> {
  const userNamespace = await run(
    ["unshare", "--user", "--map-root-user", "/usr/bin/true"],
    { cwd: root, env: process.env },
  );
  checks.push({
    id: "native-linux-user-namespace",
    status: userNamespace.code === 0 ? "pass" : "fail",
    detail: JSON.stringify(userNamespace),
  });

  const bwrapBaseArgs = [
    "bwrap",
    "--new-session",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-pid",
    "--proc",
    "/proc",
  ];
  const bwrapBase = await run([...bwrapBaseArgs, "--", "/usr/bin/true"], {
    cwd: root,
    env: process.env,
  });
  checks.push({
    id: "native-linux-bwrap-base",
    status: bwrapBase.code === 0 ? "pass" : "fail",
    detail: JSON.stringify(bwrapBase),
  });

  const bwrapNetwork = await run(
    [...bwrapBaseArgs, "--unshare-net", "--", "/usr/bin/true"],
    { cwd: root, env: process.env },
  );
  checks.push({
    id: "native-linux-bwrap-network",
    status: bwrapNetwork.code === 0 ? "pass" : "fail",
    detail: JSON.stringify(bwrapNetwork),
  });

  const socketPath = path.join(root, "native-listener.sock");
  const unixListener = await run(
    [
      process.execPath,
      "-e",
      [
        'const net = require("node:net")',
        "const socketPath = process.argv[1]",
        "const server = net.createServer()",
        'server.once("error", (error) => { console.error(error.message); process.exitCode = 1 })',
        'server.listen(socketPath, () => server.close(() => {}))',
      ].join(";"),
      socketPath,
    ],
    { cwd: root, env: process.env },
  );
  await fs.rm(socketPath, { force: true });
  checks.push({
    id: "native-linux-unix-listener",
    status: unixListener.code === 0 ? "pass" : "fail",
    detail: JSON.stringify(unixListener),
  });
}

function linuxAncestorNames(startPid: number): string[] {
  const names: string[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const name = status.match(/^Name:\s+(.+)$/m)?.[1]?.trim();
    const parent = status.match(/^PPid:\s+(\d+)$/m)?.[1];
    if (name) {
      names.push(name);
    }
    if (!parent) {
      break;
    }
    pid = Number(parent);
  }
  return names;
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
