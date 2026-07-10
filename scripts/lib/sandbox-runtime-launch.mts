import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { startAgent } from "./acp-client.mts";
import type { AgentLaunchLease } from "./acp-client.mts";
import { startEgressProxy } from "./egress-proxy.mts";
import type { EgressProxy, EgressProxyOptions } from "./egress-proxy.mts";
import type { JobAuthority } from "./job-authority.mts";
import type {
  JobAuthorityPreflightInput,
  JobAuthorityPreflightResult,
} from "./job-authority-preflight.mts";
import { DEFAULT_JOB_WALL_CLOCK_LIMIT_MS } from "./job-reliability.mts";
import type { AgentLaunchOptions } from "./process-sandbox.mts";
import {
  archiveConfinedSessionState,
  restoreConfinedSessionState,
} from "./confined-session-state.mts";
import { pidIsAlive as defaultPidIsAlive } from "./process.mts";
import {
  SANDBOX_RUNTIME_VERSION,
  assertSandboxRuntimeLiteralPath,
  snapshotSandboxRuntimeSharedWritePaths,
  transformSandboxRuntimeLaunch,
} from "./sandbox-runtime-policy.mts";

const JOB_ROOT_PREFIX = "/tmp/consult-srt-job-";
const JOB_ROOT_OWNER_FILE = ".consult-owner.json";
const STALE_JOB_ROOT_AGE_MS = DEFAULT_JOB_WALL_CLOCK_LIMIT_MS + 5 * 60 * 1000;
const require = createRequire(import.meta.url);
const installedSandboxRuntimeVersion = readInstalledSandboxRuntimeVersion();

const LINUX_READ_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/dev",
  "/proc",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
] as const;

const MACOS_READ_PATHS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library",
  "/dev",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/select",
] as const;

const SAFE_ENV_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "CONSULT_PARENT_JOB",
  "CONSULT_WORKSPACE",
  "CONSULT_HOST",
  "CONSULT_HOST_SESSION_ID",
] as const;

interface ConfinedProfilePolicy {
  credentialEnv: readonly string[];
  credentialFile: string;
  sourceConfigEnv?: string;
  stagedConfigDir: string;
  childConfigEnv: string;
  trustedHosts: readonly string[];
  requiredCommands: readonly string[];
}

export const CONFINED_PROFILE_POLICIES: Readonly<
  Record<"codex" | "claude", ConfinedProfilePolicy>
> = Object.freeze({
  codex: Object.freeze({
    credentialEnv: Object.freeze(["OPENAI_API_KEY"]),
    credentialFile: "auth.json",
    sourceConfigEnv: "CODEX_HOME",
    stagedConfigDir: ".codex",
    childConfigEnv: "CODEX_HOME",
    trustedHosts: Object.freeze([
      "api.openai.com",
      "chatgpt.com",
      "auth.openai.com",
    ]),
    requiredCommands: Object.freeze(["codex"]),
  }),
  claude: Object.freeze({
    credentialEnv: Object.freeze([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]),
    credentialFile: ".credentials.json",
    sourceConfigEnv: "CLAUDE_CONFIG_DIR",
    stagedConfigDir: ".claude",
    childConfigEnv: "CLAUDE_CONFIG_DIR",
    trustedHosts: Object.freeze(["api.anthropic.com"]),
    requiredCommands: Object.freeze([]),
  }),
});

type SupportedPlatform = "linux" | "darwin";

interface SandboxRuntimeManagerLike {
  isSupportedPlatform(): boolean;
  checkDependencies(): { errors: readonly unknown[]; warnings: readonly unknown[] };
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    shell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
    cwd?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

export interface ConfinedSandboxRuntimeLaunchInput extends AgentLaunchOptions {
  authority: JobAuthority;
  stateWorkspaceRoot?: string;
  jobId?: string;
  resumeSourceJobId?: string | null;
  resumeSessionId?: string | null;
}

export interface ConfinedSandboxRuntimeLaunchDeps {
  manager?: SandboxRuntimeManagerLike;
  platform?: NodeJS.Platform;
  startProxy?: (options: EgressProxyOptions) => Promise<EgressProxy>;
  startAgent?: typeof startAgent;
  now?: () => number;
  pidIsAlive?: (pid: number) => boolean;
}

export interface ConfinedSandboxRuntimeProbeInput
  extends JobAuthorityPreflightInput {
  /** Resolved built-in registry identity for configured Profile aliases. */
  profileRegistryId?: string;
}

let runtimeState: "idle" | "active" | "poisoned" = "idle";

export async function acquireConfinedSandboxRuntimeLaunch(
  input: ConfinedSandboxRuntimeLaunchInput,
  deps: ConfinedSandboxRuntimeLaunchDeps = {},
): Promise<AgentLaunchLease> {
  const platform = supportedPlatform(deps.platform ?? process.platform);
  const profile = confinedProfilePolicy(input.profileRegistryId);
  assertConfinedAuthority(input.authority, input.mode);
  const manager = deps.manager ?? SandboxManager;
  assertRuntimeReady(manager);
  if (runtimeState !== "idle") {
    throw new Error(
      runtimeState === "poisoned"
        ? "confined Sandbox Runtime is unavailable after a cleanup failure; restart Consult"
        : "a confined Sandbox Runtime launch is active or retained after unconfirmed process termination; restart Consult if no Job is running",
    );
  }
  runtimeState = "active";

  let root: string | undefined;
  let proxy: EgressProxy | undefined;
  let managerTouched = false;
  let wrapped = false;
  let releasePromise: Promise<void> | undefined;

  const release = async (): Promise<void> => {
    releasePromise ??= cleanup();
    await releasePromise;
  };

  const cleanup = async (): Promise<void> => {
    const errors: unknown[] = [];
    if (wrapped) {
      try {
        manager.cleanupAfterCommand();
      } catch (error) {
        errors.push(error);
      }
    }
    let resetSucceeded = true;
    if (managerTouched) {
      try {
        await manager.reset();
      } catch (error) {
        resetSucceeded = false;
        errors.push(error);
      }
    }
    if (proxy) {
      try {
        await proxy.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (root) {
      try {
        await fsp.rm(root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    runtimeState = managerTouched && !resetSucceeded ? "poisoned" : "idle";
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "confined Sandbox Runtime cleanup failed");
    }
  };

  try {
    const now = (deps.now ?? Date.now)();
    await sweepStaleJobRoots(now, deps.pidIsAlive ?? defaultPidIsAlive);
    root = await createPrivateJobRoot(now);
    const workspaceRoot = await realDirectory(input.workspaceRoot ?? input.cwd, "Workspace");
    const cwd = await realDirectory(input.cwd, "Profile working directory");
    assertSandboxRuntimeLiteralPath(workspaceRoot, "Workspace path");
    assertSandboxRuntimeLiteralPath(cwd, "Profile working directory");
    assertPathWithin(cwd, workspaceRoot, "Profile working directory");

    const home = path.join(root, "home");
    const temp = path.join(root, "tmp");
    const bin = path.join(root, "bin");
    const cache = path.join(home, ".cache");
    const data = path.join(home, ".local", "share");
    const config = path.join(home, ".config");
    await Promise.all([
      privateDirectory(home),
      privateDirectory(temp),
      privateDirectory(bin),
      privateDirectory(cache),
      privateDirectory(data),
      privateDirectory(config),
    ]);

    const sourceHome = trustedHostHome();
    const hostEnv = { ...process.env, ...input.env };
    const sourceConfig = profileSourceConfigDirectory(profile, hostEnv, sourceHome);
    const stagedConfig = path.join(home, profile.stagedConfigDir);
    await privateDirectory(stagedConfig);
    const stagedCredential = await stageOptionalRegularFile(
      path.join(sourceConfig, profile.credentialFile),
      path.join(stagedConfig, profile.credentialFile),
    );
    const credentialEnv = stagedCredential ? {} : selectedCredentialEnv(profile, hostEnv);
    if (!stagedCredential && Object.keys(credentialEnv).length === 0) {
      throw new Error(
        `confined ${input.profileRegistryId} Profile has no staged credential or supported credential environment variable`,
      );
    }
    if (input.resumeSourceJobId || input.resumeSessionId) {
      if (!input.resumeSourceJobId || !input.resumeSessionId) {
        throw new Error(
          "SESSION_STATE_ARCHIVE_FAILED: confined resume requires both a source Job and Session id",
        );
      }
      await restoreConfinedSessionState({
        workspaceRoot: input.stateWorkspaceRoot ?? input.workspaceRoot ?? input.cwd,
        jobId: input.resumeSourceJobId,
        profileRegistryId: input.profileRegistryId ?? "",
        sessionId: input.resumeSessionId,
        cwd,
        privateHome: home,
      });
    }

    const resolvedBinary = resolveExecutable(input.binary, hostEnv);
    const runtimeExecutables = new Map<string, string>();
    for (const command of profile.requiredCommands) {
      runtimeExecutables.set(command, resolveExecutable(command, hostEnv));
    }
    if (await executableNeedsNode(resolvedBinary)) {
      runtimeExecutables.set("node", resolveExecutable("node", hostEnv));
    }
    const stagedAgent = path.join(bin, "consult-profile-agent");
    await fsp.symlink(resolvedBinary, stagedAgent);
    for (const [name, executable] of runtimeExecutables) {
      await fsp.symlink(executable, path.join(bin, name));
    }

    proxy = await (deps.startProxy ?? startEgressProxy)({
      trustedHosts: profile.trustedHosts,
      allowPublicHosts: input.authority.allowFetch,
    });

    const readPaths = existingPaths([
      ...(platform === "linux" ? LINUX_READ_PATHS : MACOS_READ_PATHS),
      workspaceRoot,
      home,
      temp,
      bin,
      ...executableReadScopes(require.resolve("@anthropic-ai/sandbox-runtime")),
      ...executableReadScopes(resolvedBinary),
      ...[...runtimeExecutables.values()].flatMap(executableReadScopes),
    ]);
    const hostDefaultWritePaths = [
      path.join(sourceHome, ".npm", "_logs"),
      path.join(sourceHome, ".claude", "debug"),
    ];
    for (const readablePath of readPaths) {
      assertSandboxRuntimeLiteralPath(readablePath, "Sandbox Runtime read path");
    }
    for (const deniedWritePath of existingPaths(hostDefaultWritePaths)) {
      assertSandboxRuntimeLiteralPath(deniedWritePath, "Sandbox Runtime denied write path");
    }
    const runtimeConfig: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        httpProxyPort: proxy.httpPort,
        socksProxyPort: proxy.socksPort,
        allowLocalBinding: false,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: ["/"],
        allowRead: readPaths,
        allowWrite: [home, temp, ...(input.authority.mode === "write" ? [workspaceRoot] : [])],
        denyWrite: existingPaths(hostDefaultWritePaths),
        allowGitConfig: false,
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
    };

    managerTouched = true;
    await manager.initialize(runtimeConfig);
    const command = quoteCommand(stagedAgent, input.args ?? []);
    const generated = await manager.wrapWithSandboxArgv(
      command,
      platform === "darwin" ? "/bin/zsh" : "/bin/bash",
      undefined,
      undefined,
      cwd,
    );
    wrapped = true;
    const transformed = transformSandboxRuntimeLaunch({
      launch: generated,
      platform,
      runtimeVersion: installedSandboxRuntimeVersion,
      jobTempDir: temp,
      proxyToken: proxy.token,
      externalHttpPort: proxy.httpPort,
      externalSocksPort: proxy.socksPort,
      sharedDefaultWritePaths: snapshotSandboxRuntimeSharedWritePaths(hostDefaultWritePaths),
      allowedWritePaths: runtimeConfig.filesystem?.allowWrite ?? [],
    });
    const childEnv = sanitizedChildEnv({
      source: hostEnv,
      credentialEnv,
      profile,
      home,
      temp,
      bin,
      cache,
      data,
      config,
      stagedConfig,
    });

    return {
      launch: {
        binary: transformed.argv[0],
        args: transformed.argv.slice(1),
        cwd,
        env: childEnv,
      },
      archiveSessionState: async ({ sessionId, cwd: sessionCwd }) =>
        await archiveConfinedSessionState({
          workspaceRoot: input.stateWorkspaceRoot ?? input.workspaceRoot ?? input.cwd,
          jobId:
            input.jobId ??
            (() => {
              throw new Error(
                "SESSION_STATE_ARCHIVE_FAILED: confined Job id is unavailable",
              );
            })(),
          profileRegistryId: input.profileRegistryId ?? "",
          sessionId,
          cwd: sessionCwd,
          privateHome: home,
        }),
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      noteCleanupFailure(error, cleanupError);
    }
    throw error;
  }
}

export async function probeConfinedSandboxRuntime(
  input: ConfinedSandboxRuntimeProbeInput,
  deps: ConfinedSandboxRuntimeLaunchDeps = {},
): Promise<JobAuthorityPreflightResult> {
  const profileRegistryId = input.profileRegistryId ?? input.profile;
  try {
    supportedPlatform(input.platform ?? deps.platform ?? process.platform);
    confinedProfilePolicy(profileRegistryId);
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        code:
          (input.platform ?? deps.platform ?? process.platform) === "win32"
            ? "AUTHORITY_PLATFORM_UNSUPPORTED"
            : "AUTHORITY_COMBINATION_UNSUPPORTED",
        message: errorMessage(error),
        remediation:
          "Use a built-in codex or claude Profile on native Linux or macOS, or explicitly choose inherited ambient authority.",
      },
    };
  }

  if (!input.profileLaunch) {
    return {
      ok: false,
      diagnostic: {
        code: "AUTHORITY_COMBINATION_UNSUPPORTED",
        message: `confined authority preflight requires the exact '${input.profile}' Profile launch`,
        remediation:
          "Re-run Consult setup for this Profile, or explicitly choose inherited ambient authority.",
      },
    };
  }

  let agent: Awaited<ReturnType<typeof startAgent>> | undefined;
  let failure: unknown;
  try {
    agent = await (deps.startAgent ?? startAgent)({
      binary: input.profileLaunch.binary,
      args: input.profileLaunch.args,
      env: input.profileLaunch.env,
      cwd: input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      mode: input.authority.mode,
      sandbox: "off",
      profileRegistryId,
    }, {
      acquireLaunch: async (launchOptions) =>
        await acquireConfinedSandboxRuntimeLaunch({
          ...launchOptions,
          authority: input.authority,
        }, deps),
    });
  } catch (error) {
    failure = error;
  } finally {
    if (agent) {
      try {
        await agent.dispose();
      } catch (error) {
        if (failure === undefined) failure = error;
        else noteCleanupFailure(failure, error);
      }
    }
  }
  if (failure !== undefined) {
    return {
      ok: false,
      diagnostic: {
        code: "AUTHORITY_PREFLIGHT_FAILED",
        message: `confined authority preflight failed: ${preflightFailureMessage(failure)}`,
        remediation:
          "Run consult doctor --json and fix the reported sandbox dependency, credential, or nesting failure; no Job was created.",
      },
    };
  }
  return { ok: true, authority: input.authority };
}

function confinedProfilePolicy(registryId: string | undefined): ConfinedProfilePolicy {
  const policy = CONFINED_PROFILE_POLICIES[registryId as "codex" | "claude"];
  if (!policy) {
    throw new Error(
      `confined authority is unsupported for Profile registry identity '${registryId ?? "custom"}'`,
    );
  }
  return policy;
}

function supportedPlatform(platform: NodeJS.Platform): SupportedPlatform {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`confined authority is unsupported on ${platform}`);
  }
  return platform;
}

function assertConfinedAuthority(authority: JobAuthority, mode: string | undefined): void {
  if (authority.confinement !== "confined") {
    throw new Error("confined Sandbox Runtime launch requires confined Job Authority");
  }
  if (mode !== authority.mode) {
    throw new Error("confined Sandbox Runtime launch mode disagrees with Job Authority");
  }
}

function assertRuntimeReady(manager: SandboxRuntimeManagerLike): void {
  if (!manager.isSupportedPlatform()) {
    throw new Error("Sandbox Runtime does not support this platform");
  }
  const dependencies = manager.checkDependencies();
  if (dependencies.errors.length > 0 || dependencies.warnings.length > 0) {
    const details = [
      ...dependencies.errors.map((message) => `error: ${dependencyMessage(message)}`),
      ...dependencies.warnings.map((message) => `warning: ${dependencyMessage(message)}`),
    ].join("; ");
    throw new Error(
      `Sandbox Runtime dependencies are not ready: ${details}`,
    );
  }
}

function dependencyMessage(value: unknown): string {
  return String(value).replace(/[\r\n]+/gu, " ").slice(0, 500);
}

async function createPrivateJobRoot(now: number): Promise<string> {
  const raw = await fsp.mkdtemp(JOB_ROOT_PREFIX);
  try {
    await fsp.chmod(raw, 0o700);
    await fsp.writeFile(
      path.join(raw, JOB_ROOT_OWNER_FILE),
      `${JSON.stringify({ pid: process.pid, createdAt: now })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return await fsp.realpath(raw);
  } catch (error) {
    await fsp.rm(raw, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function sweepStaleJobRoots(
  now: number,
  pidIsAlive: (pid: number) => boolean,
): Promise<void> {
  const parent = path.dirname(JOB_ROOT_PREFIX);
  const prefix = path.basename(JOB_ROOT_PREFIX);
  const entries = await fsp.readdir(parent, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) return;
    const candidate = path.join(parent, entry.name);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(candidate);
    } catch {
      return;
    }
    if (!stat.isDirectory() || now - stat.mtimeMs <= STALE_JOB_ROOT_AGE_MS) return;

    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(
        await fsp.readFile(path.join(candidate, JOB_ROOT_OWNER_FILE), "utf8"),
      ) as { pid?: unknown };
      if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
        ownerPid = Number(owner.pid);
      }
    } catch {
      // Old or interrupted roots may not have an ownership marker.
    }
    if (ownerPid !== undefined && pidIsAlive(ownerPid)) return;
    await fsp.rm(candidate, { recursive: true, force: true }).catch(() => {});
  }));
}

async function privateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
}

function trustedHostHome(): string {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) {
    throw new Error("Consult Host HOME must be an absolute path for confined Profile staging");
  }
  return fs.realpathSync(home);
}

function profileSourceConfigDirectory(
  profile: ConfinedProfilePolicy,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const configured = profile.sourceConfigEnv ? env[profile.sourceConfigEnv] : undefined;
  const source = configured ?? path.join(home, profile.stagedConfigDir);
  if (!path.isAbsolute(source)) {
    throw new Error(`${profile.sourceConfigEnv} must be an absolute path for confined staging`);
  }
  try {
    return fs.realpathSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return source;
    throw error;
  }
}

async function stageOptionalRegularFile(source: string, destination: string): Promise<boolean> {
  let realSource: string;
  try {
    realSource = await fsp.realpath(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const stat = await fsp.stat(realSource);
  if (!stat.isFile()) {
    throw new Error(`confined Profile staging source is not a regular file: ${source}`);
  }
  await fsp.writeFile(destination, await fsp.readFile(realSource), {
    flag: "wx",
    mode: 0o600,
  });
  await fsp.chmod(destination, 0o600);
  return true;
}

function selectedCredentialEnv(
  profile: ConfinedProfilePolicy,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of profile.credentialEnv) {
    const value = source[name];
    if (value) {
      selected[name] = value;
      break;
    }
  }
  return selected;
}

function sanitizedChildEnv(input: {
  source: NodeJS.ProcessEnv;
  credentialEnv: NodeJS.ProcessEnv;
  profile: ConfinedProfilePolicy;
  home: string;
  temp: string;
  bin: string;
  cache: string;
  data: string;
  config: string;
  stagedConfig: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${input.bin}:/usr/bin:/bin`,
    HOME: input.home,
    TMPDIR: input.temp,
    XDG_CACHE_HOME: input.cache,
    XDG_CONFIG_HOME: input.config,
    XDG_DATA_HOME: input.data,
    IS_SANDBOX: "1",
    [input.profile.childConfigEnv]: input.stagedConfig,
    ...input.credentialEnv,
  };
  for (const name of SAFE_ENV_KEYS) {
    const value = input.source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function realDirectory(directory: string, label: string): Promise<string> {
  const real = await fsp.realpath(directory);
  const stat = await fsp.stat(real);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  return real;
}

function assertPathWithin(candidate: string, parent: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the confined Workspace`);
  }
}

function resolveExecutable(binary: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(binary)) {
    fs.accessSync(binary, fs.constants.X_OK);
    return fs.realpathSync(binary);
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue through the trusted Host PATH snapshot.
    }
  }
  throw new Error(`confined Profile executable not found: ${binary}`);
}

async function executableNeedsNode(executable: string): Promise<boolean> {
  const handle = await fsp.open(executable, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0];
    return firstLine.startsWith("#!") && /(?:^|[ /])node(?:$|\s)/u.test(firstLine);
  } finally {
    await handle.close();
  }
}

function executableReadScopes(executable: string): string[] {
  const scopes = new Set<string>([executable, path.dirname(executable)]);
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = executable.indexOf(marker);
  if (markerIndex !== -1) {
    const packageStart = markerIndex + marker.length;
    const segments = executable.slice(packageStart).split(path.sep);
    const packageSegments = segments[0]?.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
    if (packageSegments.length > 0) {
      scopes.add(path.join(executable.slice(0, packageStart), ...packageSegments));
    }
  }
  const appIndex = executable.indexOf(".app/Contents/");
  if (appIndex !== -1) scopes.add(executable.slice(0, appIndex + ".app".length));
  const cellarMarker = `${path.sep}Cellar${path.sep}`;
  const cellarIndex = executable.indexOf(cellarMarker);
  if (cellarIndex !== -1) {
    const cellarPackageStart = cellarIndex + cellarMarker.length;
    const cellarSegments = executable.slice(cellarPackageStart).split(path.sep);
    if (cellarSegments.length >= 2) {
      scopes.add(
        path.join(
          executable.slice(0, cellarPackageStart),
          cellarSegments[0],
          cellarSegments[1],
        ),
      );
    }
  }
  return [...scopes];
}

function existingPaths(paths: readonly string[]): string[] {
  const existing = new Set<string>();
  for (const candidate of paths) {
    try {
      fs.lstatSync(candidate);
      existing.add(candidate);
      existing.add(fs.realpathSync(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...existing];
}

function readInstalledSandboxRuntimeVersion(): string {
  const packageMetadata = require("@anthropic-ai/sandbox-runtime/package.json") as {
    version?: unknown;
  };
  return typeof packageMetadata.version === "string"
    ? packageMetadata.version
    : `invalid (expected ${SANDBOX_RUNTIME_VERSION})`;
}

function quoteCommand(binary: string, args: readonly string[]): string {
  return [binary, ...args].map(quoteShellWord).join(" ");
}

function quoteShellWord(value: string): string {
  if (value.includes("\0")) throw new Error("Profile argument contains NUL");
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function noteCleanupFailure(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) return;
  Object.defineProperty(primary, "cleanupError", {
    configurable: true,
    enumerable: false,
    value: cleanup,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preflightFailureMessage(error: unknown): string {
  const stderr =
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
      ? error.stderr
      : "";
  if (
    /sandbox-exec:[^\r\n]*(?:sandbox_apply|operation not permitted)/iu.test(stderr)
  ) {
    return "nested macOS sandbox initialization failed: sandbox-exec was denied by the parent sandbox";
  }
  if (
    /bwrap:[^\r\n]*(?:namespace[^\r\n]*operation not permitted|no permissions to create new namespace)/iu.test(
      stderr,
    )
  ) {
    return "nested Linux sandbox initialization failed: bwrap namespace creation was denied by the parent sandbox";
  }
  return errorMessage(error);
}
