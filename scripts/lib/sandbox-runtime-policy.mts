export const SANDBOX_RUNTIME_VERSION = "0.0.64";

export const SANDBOX_RUNTIME_POLICY_ERROR =
  "SRT_POLICY_SHAPE_UNSUPPORTED" as const;

const PROXY_USERNAME = "consult";
const LINUX_HTTP_PROXY_PORT = 3128;
const LINUX_SOCKS_PROXY_PORT = 1080;
const DEFAULT_NO_PROXY =
  "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const SHARED_DEFAULT_WRITE_PATHS = [
  "/tmp/claude",
  "/private/tmp/claude",
] as const;

export interface SandboxRuntimeLaunch {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export interface TransformSandboxRuntimeLaunchInput {
  launch: SandboxRuntimeLaunch;
  platform: "linux" | "darwin";
  runtimeVersion: string;
  jobTempDir: string;
  proxyToken: string;
  externalHttpPort: number;
  externalSocksPort: number;
}

export interface SandboxRuntimePolicyError extends Error {
  code: typeof SANDBOX_RUNTIME_POLICY_ERROR;
}

/**
 * Tighten the declarative launch artifact produced by the pinned Sandbox
 * Runtime. The transform is deliberately format-sensitive: an upstream
 * version or output-shape change fails before a Profile process starts.
 */
export function transformSandboxRuntimeLaunch({
  launch,
  platform,
  runtimeVersion,
  jobTempDir,
  proxyToken,
  externalHttpPort,
  externalSocksPort,
}: TransformSandboxRuntimeLaunchInput): SandboxRuntimeLaunch {
  assertRuntimeVersion(runtimeVersion);
  assertSafeAbsolutePath(jobTempDir, "Job temp directory");
  if (!/^[0-9a-f]{64}$/u.test(proxyToken)) {
    throw policyShapeError("proxy token does not have the expected shape");
  }
  assertPort(externalHttpPort, "external HTTP proxy");
  assertPort(externalSocksPort, "external SOCKS proxy");
  if (
    launch.argv.length !== 3 ||
    launch.argv[1] !== "-c" ||
    (launch.argv[0] !== "/bin/bash" && launch.argv[0] !== "/bin/zsh")
  ) {
    throw policyShapeError("runtime launch argv does not use the expected shell wrapper");
  }

  const command =
    platform === "linux"
      ? transformLinuxPolicy(
          launch.argv[2],
          jobTempDir,
          proxyToken,
          externalHttpPort,
          externalSocksPort,
        )
      : transformMacosPolicy(
          launch.argv[2],
          jobTempDir,
          proxyToken,
          externalHttpPort,
          externalSocksPort,
        );
  return { argv: [launch.argv[0], "-c", command], env: { ...launch.env } };
}

function transformLinuxPolicy(
  source: string,
  jobTempDir: string,
  proxyToken: string,
  externalHttpPort: number,
  externalSocksPort: number,
): string {
  for (const marker of [
    "bwrap --new-session --die-with-parent --unshare-net ",
    " --ro-bind / / ",
    " --tmpfs /tmp ",
    " --unshare-pid --proc /proc -- ",
    ` --setenv CLAUDE_CODE_HOST_HTTP_PROXY_PORT ${externalHttpPort} `,
    ` --setenv CLAUDE_CODE_HOST_SOCKS_PROXY_PORT ${externalSocksPort} `,
  ]) {
    assertContains(source, marker, `Linux policy marker ${JSON.stringify(marker)}`);
  }

  let command = source;
  for (const sharedPath of SHARED_DEFAULT_WRITE_PATHS) {
    const bind = ` --bind ${sharedPath} ${sharedPath}`;
    command = command.split(bind).join("");
    if (command.includes(bind)) {
      throw policyShapeError(`shared write grant remained for ${sharedPath}`);
    }
  }
  command = replaceExactlyOnce(
    command,
    "--setenv TMPDIR /tmp/claude",
    `--setenv TMPDIR ${jobTempDir}`,
    "Linux TMPDIR",
  );
  command = replaceExactlyOnce(
    command,
    `--setenv NO_PROXY ${DEFAULT_NO_PROXY}`,
    "--setenv NO_PROXY ''",
    "Linux NO_PROXY",
  );
  command = replaceExactlyOnce(
    command,
    `--setenv no_proxy ${DEFAULT_NO_PROXY}`,
    "--setenv no_proxy ''",
    "Linux no_proxy",
  );
  command = authenticateProxyUrls(
    command,
    LINUX_HTTP_PROXY_PORT,
    LINUX_SOCKS_PROXY_PORT,
    proxyToken,
  );
  assertNoUnauthenticatedProxyUrls(
    command,
    LINUX_HTTP_PROXY_PORT,
    LINUX_SOCKS_PROXY_PORT,
  );
  return command;
}

function transformMacosPolicy(
  source: string,
  jobTempDir: string,
  proxyToken: string,
  externalHttpPort: number,
  externalSocksPort: number,
): string {
  for (const marker of [
    "/usr/bin/sandbox-exec -p '",
    "(deny default ",
    "; File read\n",
    "; File write\n",
    `(allow network-outbound (remote ip "localhost:${externalHttpPort}"))`,
    `(allow network-outbound (remote ip "localhost:${externalSocksPort}"))`,
  ]) {
    assertContains(source, marker, `macOS policy marker ${JSON.stringify(marker)}`);
  }

  let command = source;
  for (const sharedPath of SHARED_DEFAULT_WRITE_PATHS) {
    let removed = 0;
    for (const operation of ["file-write-unlink", "file-write-create", "file-write\\*"]) {
      const rule = new RegExp(
        `\\(allow ${operation}\\n  \\(subpath "${escapeRegExp(sharedPath)}"\\)\\n  \\(with message "[^"\\n]+"\\)\\)\\n?`,
        "gu",
      );
      command = command.replace(rule, () => {
        removed += 1;
        return "";
      });
    }
    if (removed !== 3 || command.includes(`(subpath "${sharedPath}")`)) {
      throw policyShapeError(
        `macOS shared write rules for ${sharedPath} did not match the pinned shape`,
      );
    }
  }
  command = replaceExactlyOnce(
    command,
    "TMPDIR=/tmp/claude",
    `TMPDIR=${jobTempDir}`,
    "macOS TMPDIR",
  );
  command = replaceExactlyOnce(
    command,
    `NO_PROXY=${DEFAULT_NO_PROXY}`,
    "NO_PROXY=",
    "macOS NO_PROXY",
  );
  command = replaceExactlyOnce(
    command,
    `no_proxy=${DEFAULT_NO_PROXY}`,
    "no_proxy=",
    "macOS no_proxy",
  );
  command = authenticateProxyUrls(
    command,
    externalHttpPort,
    externalSocksPort,
    proxyToken,
  );
  assertNoUnauthenticatedProxyUrls(command, externalHttpPort, externalSocksPort);
  return command;
}

function authenticateProxyUrls(
  source: string,
  httpPort: number,
  socksPort: number,
  token: string,
): string {
  const httpSource = `http://localhost:${httpPort}`;
  const socksSource = `socks5h://localhost:${socksPort}`;
  const httpCount = occurrenceCount(source, httpSource);
  const socksCount = occurrenceCount(source, socksSource);
  if (httpCount < 6 || socksCount < 2) {
    throw policyShapeError("runtime proxy environment does not match the pinned shape");
  }
  return source
    .split(httpSource)
    .join(`http://${PROXY_USERNAME}:${token}@localhost:${httpPort}`)
    .split(socksSource)
    .join(`socks5h://${PROXY_USERNAME}:${token}@localhost:${socksPort}`);
}

function assertNoUnauthenticatedProxyUrls(
  source: string,
  httpPort: number,
  socksPort: number,
): void {
  if (
    source.includes(`http://localhost:${httpPort}`) ||
    source.includes(`socks5h://localhost:${socksPort}`)
  ) {
    throw policyShapeError("unauthenticated proxy URL remained in runtime policy");
  }
}

function assertRuntimeVersion(version: string): void {
  if (version !== SANDBOX_RUNTIME_VERSION) {
    throw policyShapeError(
      `unsupported Sandbox Runtime version ${JSON.stringify(version)}; expected ${SANDBOX_RUNTIME_VERSION}`,
    );
  }
}

function assertSafeAbsolutePath(value: string, label: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(value) || value.includes("//") || value.includes("/../")) {
    throw policyShapeError(`${label} is not a safe absolute policy path`);
  }
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw policyShapeError(`${label} port is invalid`);
  }
}

function assertContains(source: string, marker: string, label: string): void {
  if (!source.includes(marker)) {
    throw policyShapeError(`${label} is missing`);
  }
}

function replaceExactlyOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (occurrenceCount(source, search) !== 1) {
    throw policyShapeError(`${label} does not occur exactly once`);
  }
  return source.replace(search, replacement);
}

function occurrenceCount(source: string, search: string): number {
  return source.split(search).length - 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function policyShapeError(message: string): SandboxRuntimePolicyError {
  const error = new Error(`Sandbox Runtime policy rejected: ${message}`) as SandboxRuntimePolicyError;
  error.code = SANDBOX_RUNTIME_POLICY_ERROR;
  return error;
}
