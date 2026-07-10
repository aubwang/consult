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
const REQUIRED_DEVICE_WRITE_PATHS = [
  "/dev/stdout",
  "/dev/stderr",
  "/dev/null",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/autofs_nowait",
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
  sharedDefaultWritePaths: readonly string[];
  allowedWritePaths: readonly string[];
}

export interface SandboxRuntimePolicyError extends Error {
  code: typeof SANDBOX_RUNTIME_POLICY_ERROR;
}

export function assertSandboxRuntimeLiteralPath(value: string, label: string): void {
  assertSafeAbsolutePath(value, label);
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
  sharedDefaultWritePaths,
  allowedWritePaths,
}: TransformSandboxRuntimeLaunchInput): SandboxRuntimeLaunch {
  assertRuntimeVersion(runtimeVersion);
  assertSafeAbsolutePath(jobTempDir, "Job temp directory");
  if (!/^[0-9a-f]{64}$/u.test(proxyToken)) {
    throw policyShapeError("proxy token does not have the expected shape");
  }
  assertPort(externalHttpPort, "external HTTP proxy");
  assertPort(externalSocksPort, "external SOCKS proxy");
  if (sharedDefaultWritePaths.length === 0) {
    throw policyShapeError("shared default write-path snapshot is empty");
  }
  for (const sharedPath of sharedDefaultWritePaths) {
    assertSafeAbsolutePath(sharedPath, "shared default write path");
  }
  if (allowedWritePaths.length === 0) {
    throw policyShapeError("allowed write-path snapshot is empty");
  }
  for (const allowedPath of allowedWritePaths) {
    assertSafeAbsolutePath(allowedPath, "allowed write path");
  }
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
          sharedDefaultWritePaths,
          allowedWritePaths,
        )
      : transformMacosPolicy(
          launch.argv[2],
          jobTempDir,
          proxyToken,
          externalHttpPort,
          externalSocksPort,
          sharedDefaultWritePaths,
          allowedWritePaths,
        );
  return { argv: [launch.argv[0], "-c", command], env: { ...launch.env } };
}

function transformLinuxPolicy(
  source: string,
  jobTempDir: string,
  proxyToken: string,
  externalHttpPort: number,
  externalSocksPort: number,
  sharedDefaultWritePaths: readonly string[],
  allowedWritePaths: readonly string[],
): string {
  const words = parseShellWords(source);
  if (words[0] !== "bwrap") {
    throw policyShapeError("Linux policy does not start with bwrap");
  }
  for (const required of [
    ["--new-session", "--die-with-parent", "--unshare-net"],
    ["--ro-bind", "/", "/"],
    ["--tmpfs", "/tmp"],
    ["--unshare-pid", "--proc", "/proc", "--"],
  ]) {
    if (!hasSequence(words, required)) {
      throw policyShapeError(`Linux policy is missing ${required.join(" ")}`);
    }
  }
  for (const masked of ["/home", "/root", "/var", "/etc"]) {
    if (!hasSequence(words, ["--tmpfs", masked])) {
      throw policyShapeError(`Linux policy is missing the ${masked} read mask`);
    }
  }
  if (
    words.filter((word) =>
      word.includes("/vendor/seccomp/") && word.includes("/apply-seccomp"),
    ).length !== 1
  ) {
    throw policyShapeError("Linux policy does not contain exactly one pinned seccomp launcher");
  }
  assertSetenv(words, "CLAUDE_CODE_HOST_HTTP_PROXY_PORT", String(externalHttpPort));
  assertSetenv(words, "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT", String(externalSocksPort));

  const shared = new Set(sharedDefaultWritePaths);
  const allowedWrites = new Set(allowedWritePaths);
  const tightened: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (
      words[index] === "--bind" &&
      words[index + 1] === words[index + 2] &&
      shared.has(words[index + 1])
    ) {
      index += 2;
      continue;
    }
    tightened.push(words[index]);
  }
  relocateLinuxProxySocketBinds(tightened);
  replaceSetenvValueExactlyOnce(tightened, "TMPDIR", jobTempDir);
  replaceSetenvExactlyOnce(tightened, "NO_PROXY", DEFAULT_NO_PROXY, "");
  replaceSetenvExactlyOnce(tightened, "no_proxy", DEFAULT_NO_PROXY, "");
  const authenticated = authenticateProxyWords(
    tightened,
    LINUX_HTTP_PROXY_PORT,
    LINUX_SOCKS_PROXY_PORT,
    proxyToken,
  );
  assertNoUnauthenticatedProxyWords(
    authenticated,
    LINUX_HTTP_PROXY_PORT,
    LINUX_SOCKS_PROXY_PORT,
  );
  assertLinuxWriteBinds(authenticated, allowedWrites);
  for (let index = 0; index < authenticated.length - 2; index += 1) {
    if (
      authenticated[index] === "--bind" &&
      authenticated[index + 1] === authenticated[index + 2] &&
      shared.has(authenticated[index + 1])
    ) {
      throw policyShapeError(`shared write grant remained for ${authenticated[index + 1]}`);
    }
  }
  return quoteShellWords(authenticated);
}

function assertLinuxWriteBinds(words: readonly string[], allowedWrites: ReadonlySet<string>): void {
  const proxySocketPattern = /^\/tmp\/claude-(?:http|socks)-[0-9a-f]{16}\.sock$/u;
  for (let index = 0; index < words.length - 2; index += 1) {
    if (words[index] !== "--bind") continue;
    const source = words[index + 1];
    const target = words[index + 2];
    if (source !== target) continue;
    if (!proxySocketPattern.test(source) && !allowedWrites.has(source)) {
      throw policyShapeError(`unexpected Linux writable bind remained for ${source}`);
    }
  }
}

function relocateLinuxProxySocketBinds(words: string[]): void {
  const socketPattern = /^\/tmp\/claude-(http|socks)-[0-9a-f]{16}\.sock$/u;
  const socketBinds: string[][] = [];
  const retained: string[] = [];
  const kinds = new Set<string>();

  for (let index = 0; index < words.length; index += 1) {
    const socketMatch = socketPattern.exec(words[index + 1] ?? "");
    if (
      words[index] === "--bind" &&
      socketMatch &&
      words[index + 1] === words[index + 2]
    ) {
      socketBinds.push(words.slice(index, index + 3));
      kinds.add(socketMatch[1]);
      index += 2;
      continue;
    }
    retained.push(words[index]);
  }

  if (socketBinds.length !== 2 || kinds.size !== 2) {
    throw policyShapeError("Linux proxy socket binds do not match the pinned shape");
  }
  const tmpfsIndexes: number[] = [];
  for (let index = 0; index < retained.length - 1; index += 1) {
    if (retained[index] === "--tmpfs" && retained[index + 1] === "/tmp") {
      tmpfsIndexes.push(index);
    }
  }
  if (tmpfsIndexes.length !== 1) {
    throw policyShapeError("Linux /tmp mount does not match the pinned shape");
  }
  retained.splice(tmpfsIndexes[0] + 2, 0, ...socketBinds.flat());
  words.splice(0, words.length, ...retained);
}

function transformMacosPolicy(
  source: string,
  jobTempDir: string,
  proxyToken: string,
  externalHttpPort: number,
  externalSocksPort: number,
  sharedDefaultWritePaths: readonly string[],
  allowedWritePaths: readonly string[],
): string {
  const words = parseShellWords(source);
  const sandboxIndex = words.indexOf("/usr/bin/sandbox-exec");
  if (
    words[0] !== "env" ||
    sandboxIndex < 1 ||
    words[sandboxIndex + 1] !== "-p" ||
    typeof words[sandboxIndex + 2] !== "string"
  ) {
    throw policyShapeError("macOS sandbox-exec policy does not match the pinned argv shape");
  }
  let profile = words[sandboxIndex + 2];
  for (const marker of [
    "(deny default ",
    "; File read\n",
    "; File write\n",
    `(allow network-outbound (remote ip "localhost:${externalHttpPort}"))`,
    `(allow network-outbound (remote ip "localhost:${externalSocksPort}"))`,
  ]) {
    assertContains(profile, marker, `macOS policy marker ${JSON.stringify(marker)}`);
  }

  for (const sharedPath of sharedDefaultWritePaths) {
    for (const operation of ["file-write-unlink", "file-write-create", "file-write\\*"]) {
      const rule = new RegExp(
        `\\(allow ${operation}\\n  \\(subpath "${escapeRegExp(sharedPath)}"\\)\\n  \\(with message "[^"\\n]+"\\)\\)\\n?`,
        "gu",
      );
      profile = profile.replace(rule, "");
    }
  }
  assertMacosWriteRules(
    profile,
    new Set([
      ...snapshotPolicyPaths(allowedWritePaths),
      ...snapshotPolicyPaths(REQUIRED_DEVICE_WRITE_PATHS),
    ]),
  );
  words[sandboxIndex + 2] = profile;
  replaceEnvAssignmentValueExactlyOnce(words, "TMPDIR", jobTempDir);
  replaceEnvAssignmentExactlyOnce(words, "NO_PROXY", DEFAULT_NO_PROXY, "");
  replaceEnvAssignmentExactlyOnce(words, "no_proxy", DEFAULT_NO_PROXY, "");
  const authenticated = authenticateProxyWords(
    words,
    externalHttpPort,
    externalSocksPort,
    proxyToken,
  );
  assertNoUnauthenticatedProxyWords(authenticated, externalHttpPort, externalSocksPort);
  return quoteShellWords(authenticated);
}

function assertMacosWriteRules(profile: string, allowedWrites: ReadonlySet<string>): void {
  const rulePattern = /\(allow file-write[^\n]*\n  \(subpath "([^"\n]+)"\)\n  \(with message "[^"\n]+"\)\)/gu;
  const matches = [...profile.matchAll(rulePattern)];
  const ruleCount = occurrenceCount(profile, "(allow file-write");
  if (matches.length !== ruleCount) {
    throw policyShapeError("macOS file-write rules do not match the pinned subpath shape");
  }
  for (const match of matches) {
    if (!allowedWrites.has(match[1])) {
      throw policyShapeError(`unexpected macOS writable subpath remained for ${match[1]}`);
    }
  }
}

function authenticateProxyWords(
  words: readonly string[],
  httpPort: number,
  socksPort: number,
  token: string,
): string[] {
  const httpSource = `http://localhost:${httpPort}`;
  const socksSource = `socks5h://localhost:${socksPort}`;
  const httpCount = words.reduce((count, word) => count + occurrenceCount(word, httpSource), 0);
  const socksCount = words.reduce((count, word) => count + occurrenceCount(word, socksSource), 0);
  if (httpCount < 6 || socksCount < 2) {
    throw policyShapeError("runtime proxy environment does not match the pinned shape");
  }
  return words.map((word) =>
    word
      .split(httpSource)
      .join(`http://${PROXY_USERNAME}:${token}@localhost:${httpPort}`)
      .split(socksSource)
      .join(`socks5h://${PROXY_USERNAME}:${token}@localhost:${socksPort}`),
  );
}

function assertNoUnauthenticatedProxyWords(
  words: readonly string[],
  httpPort: number,
  socksPort: number,
): void {
  if (
    words.some(
      (word) =>
        word.includes(`http://localhost:${httpPort}`) ||
        word.includes(`socks5h://localhost:${socksPort}`),
    )
  ) {
    throw policyShapeError("unauthenticated proxy URL remained in runtime policy");
  }
}

function parseShellWords(source: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | null = null;

  const finishWord = (): void => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\") {
        if (index + 1 >= source.length) {
          throw policyShapeError("runtime shell artifact ends in an escape");
        }
        word += source[index + 1];
        index += 1;
        continue;
      }
      if (character === "$" || character === "`") {
        throw policyShapeError("runtime shell artifact contains expansion syntax");
      }
      word += character;
      continue;
    }

    if (/\s/u.test(character)) {
      finishWord();
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= source.length) {
        throw policyShapeError("runtime shell artifact ends in an escape");
      }
      word += source[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (/[;$`|&<>()#]/u.test(character)) {
      throw policyShapeError("runtime shell artifact contains unsupported control syntax");
    }
    word += character;
    started = true;
  }
  if (quote !== null) {
    throw policyShapeError("runtime shell artifact has an unterminated quote");
  }
  finishWord();
  if (words.length === 0) {
    throw policyShapeError("runtime shell artifact is empty");
  }
  return words;
}

function quoteShellWords(words: readonly string[]): string {
  return words.map(quoteShellWord).join(" ");
}

function quoteShellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(word)) {
    return word;
  }
  return `'${word.replace(/'/gu, `'"'"'`)}'`;
}

function hasSequence(words: readonly string[], sequence: readonly string[]): boolean {
  return words.some(
    (_word, start) =>
      start + sequence.length <= words.length &&
      sequence.every((expected, offset) => words[start + offset] === expected),
  );
}

function assertSetenv(words: readonly string[], name: string, value: string): void {
  if (!hasSequence(words, ["--setenv", name, value])) {
    throw policyShapeError(`Linux ${name} does not match the pinned shape`);
  }
}

function replaceSetenvExactlyOnce(
  words: string[],
  name: string,
  expected: string,
  replacement: string,
): void {
  const matches: number[] = [];
  for (let index = 0; index < words.length - 2; index += 1) {
    if (
      words[index] === "--setenv" &&
      words[index + 1] === name &&
      words[index + 2] === expected
    ) {
      matches.push(index + 2);
    }
  }
  if (matches.length !== 1) {
    throw policyShapeError(`Linux ${name} does not occur exactly once`);
  }
  words[matches[0]] = replacement;
}

function replaceSetenvValueExactlyOnce(
  words: string[],
  name: string,
  replacement: string,
): void {
  const matches: number[] = [];
  for (let index = 0; index < words.length - 2; index += 1) {
    if (words[index] === "--setenv" && words[index + 1] === name) {
      matches.push(index + 2);
    }
  }
  if (matches.length !== 1) {
    throw policyShapeError(`Linux ${name} does not occur exactly once`);
  }
  words[matches[0]] = replacement;
}

function replaceEnvAssignmentExactlyOnce(
  words: string[],
  name: string,
  expected: string,
  replacement: string,
): void {
  const target = `${name}=${expected}`;
  const matches = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => word === target);
  if (matches.length !== 1) {
    throw policyShapeError(`macOS ${name} does not occur exactly once`);
  }
  words[matches[0].index] = `${name}=${replacement}`;
}

function replaceEnvAssignmentValueExactlyOnce(
  words: string[],
  name: string,
  replacement: string,
): void {
  const prefix = `${name}=`;
  const matches = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => word.startsWith(prefix));
  if (matches.length !== 1) {
    throw policyShapeError(`macOS ${name} does not occur exactly once`);
  }
  words[matches[0].index] = `${name}=${replacement}`;
}

export function snapshotSandboxRuntimeSharedWritePaths(
  additionalPaths: readonly string[] = [],
): string[] {
  return snapshotPolicyPaths([...SHARED_DEFAULT_WRITE_PATHS, ...additionalPaths]);
}

function snapshotPolicyPaths(paths: readonly string[]): string[] {
  const snapshot = new Set<string>();
  for (const sharedPath of paths) {
    assertSafeAbsolutePath(sharedPath, "shared default write path");
    snapshot.add(sharedPath);
    try {
      snapshot.add(fs.realpathSync(sharedPath));
    } catch {
      // A missing path is omitted by SRT; retain the raw spelling as the tripwire.
    }
  }
  return [...snapshot];
}

function assertRuntimeVersion(version: string): void {
  if (version !== SANDBOX_RUNTIME_VERSION) {
    throw policyShapeError(
      `unsupported Sandbox Runtime version ${JSON.stringify(version)}; expected ${SANDBOX_RUNTIME_VERSION}`,
    );
  }
}

function assertSafeAbsolutePath(value: string, label: string): void {
  if (/[*?\[\]]/u.test(value)) {
    throw policyShapeError(
      `${label} contains glob metacharacters that Sandbox Runtime cannot treat as a literal path`,
    );
  }
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    /[\r\n"\\]/u.test(value) ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
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
import fs from "node:fs";
