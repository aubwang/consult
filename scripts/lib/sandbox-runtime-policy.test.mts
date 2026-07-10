import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  SANDBOX_RUNTIME_POLICY_ERROR,
  SANDBOX_RUNTIME_VERSION,
  snapshotSandboxRuntimeSharedWritePaths,
  transformSandboxRuntimeLaunch,
} from "./sandbox-runtime-policy.mts";

const TOKEN = "ab".repeat(32);
const NO_PROXY =
  "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

test("tightens the pinned Linux artifact without changing its outer launch", () => {
  const source = [
    "bwrap --new-session --die-with-parent --unshare-net",
    "--setenv TMPDIR /tmp/claude",
    `--setenv NO_PROXY ${NO_PROXY}`,
    `--setenv no_proxy ${NO_PROXY}`,
    "--setenv HTTP_PROXY http://localhost:3128",
    "--setenv HTTPS_PROXY http://localhost:3128",
    "--setenv http_proxy http://localhost:3128",
    "--setenv https_proxy http://localhost:3128",
    "--setenv ALL_PROXY http://localhost:3128",
    "--setenv all_proxy http://localhost:3128",
    "--setenv FTP_PROXY socks5h://localhost:1080",
    "--setenv ftp_proxy socks5h://localhost:1080",
    "--setenv CLAUDE_CODE_HOST_HTTP_PROXY_PORT 41001",
    "--setenv CLAUDE_CODE_HOST_SOCKS_PROXY_PORT 41002",
    "--ro-bind / /",
    "--tmpfs /home --tmpfs /root --tmpfs /var --tmpfs /etc",
    "--bind /tmp/claude-http-0123456789abcdef.sock /tmp/claude-http-0123456789abcdef.sock",
    "--bind /tmp/claude-socks-fedcba9876543210.sock /tmp/claude-socks-fedcba9876543210.sock",
    "--bind /tmp/claude /tmp/claude",
    "--bind /var/tmp/shared-target /var/tmp/shared-target",
    "--tmpfs /tmp",
    "--bind /tmp/claude /tmp/claude",
    "--unshare-pid --proc /proc -- /bin/bash -c /vendor/seccomp/x64/apply-seccomp",
  ].join(" ");
  const input = {
    launch: { argv: ["/bin/bash", "-c", source], env: { SAFE: "1" } },
    platform: "linux" as const,
    runtimeVersion: SANDBOX_RUNTIME_VERSION,
    jobTempDir: "/tmp/consult-job/temporary",
    proxyToken: TOKEN,
    externalHttpPort: 41001,
    externalSocksPort: 41002,
    sharedDefaultWritePaths: [
      "/tmp/claude",
      "/private/tmp/claude",
      "/var/tmp/shared-target",
    ],
    allowedWritePaths: ["/tmp/consult-job/home", "/tmp/consult-job/temporary"],
  };
  const transformed = transformSandboxRuntimeLaunch(input);

  assert.equal(transformed.argv[0], "/bin/bash");
  assert.equal(transformed.argv[1], "-c");
  assert.equal(transformed.env.SAFE, "1");
  assert.match(transformed.argv[2], /--setenv TMPDIR \/tmp\/consult-job\/temporary/u);
  assert.match(transformed.argv[2], /--setenv NO_PROXY ''/u);
  assert.match(transformed.argv[2], new RegExp(`http://consult:${TOKEN}@localhost:3128`, "u"));
  assert.match(transformed.argv[2], new RegExp(`socks5h://consult:${TOKEN}@localhost:1080`, "u"));
  assert.doesNotMatch(transformed.argv[2], /--bind \/tmp\/claude \/tmp\/claude/u);
  assert.doesNotMatch(transformed.argv[2], /--bind \/var\/tmp\/shared-target/u);
  assert.ok(
    transformed.argv[2].indexOf("--tmpfs /tmp") <
      transformed.argv[2].indexOf("--bind /tmp/claude-http-0123456789abcdef.sock"),
  );
  assert.throws(
    () =>
      transformSandboxRuntimeLaunch({
        ...input,
        launch: {
          ...input.launch,
          argv: [
            "/bin/bash",
            "-c",
            source.replace(
              "--unshare-pid",
              "--bind /etc /etc --unshare-pid",
            ),
          ],
        },
      }),
    /unexpected Linux writable bind remained for \/etc/u,
  );
});

test("tightens the pinned macOS profile rules and proxy environment", () => {
  const tag = "CMD64_dGVzdA==_END__fixed_SBX";
  const rules = ["/tmp/claude", "/private/tmp/claude"].flatMap((path) => [
    `(allow file-write-unlink\n  (subpath "${path}")\n  (with message "${tag}"))`,
    `(allow file-write-create\n  (subpath "${path}")\n  (with message "${tag}"))`,
    `(allow file-write*\n  (subpath "${path}")\n  (with message "${tag}"))`,
  ]);
  const source = [
    `env TMPDIR=/tmp/claude NO_PROXY=${NO_PROXY} no_proxy=${NO_PROXY}`,
    "HTTP_PROXY=http://localhost:41001 HTTPS_PROXY=http://localhost:41001",
    "http_proxy=http://localhost:41001 https_proxy=http://localhost:41001",
    "ALL_PROXY=http://localhost:41001 all_proxy=http://localhost:41001",
    "FTP_PROXY=socks5h://localhost:41002 ftp_proxy=socks5h://localhost:41002",
    "/usr/bin/sandbox-exec -p '(version 1)",
    `(deny default (with message "${tag}"))`,
    `(allow network-outbound (remote ip "localhost:41001"))`,
    `(allow network-outbound (remote ip "localhost:41002"))`,
    "; File read",
    "; File write",
    ...rules,
    "' /bin/zsh -c agent",
  ].join("\n");
  const input = {
    launch: { argv: ["/bin/zsh", "-c", source], env: {} },
    platform: "darwin" as const,
    runtimeVersion: SANDBOX_RUNTIME_VERSION,
    jobTempDir: "/private/tmp/consult-job/temporary",
    proxyToken: TOKEN,
    externalHttpPort: 41001,
    externalSocksPort: 41002,
    sharedDefaultWritePaths: ["/tmp/claude", "/private/tmp/claude"],
    allowedWritePaths: [
      "/private/tmp/consult-job/home",
      "/private/tmp/consult-job/temporary",
    ],
  };
  const transformed = transformSandboxRuntimeLaunch(input);

  assert.match(transformed.argv[2], /TMPDIR=\/private\/tmp\/consult-job\/temporary/u);
  assert.match(transformed.argv[2], /NO_PROXY= /u);
  assert.match(transformed.argv[2], new RegExp(`http://consult:${TOKEN}@localhost:41001`, "u"));
  assert.match(transformed.argv[2], new RegExp(`socks5h://consult:${TOKEN}@localhost:41002`, "u"));
  assert.doesNotMatch(transformed.argv[2], /subpath "\/tmp\/claude"/u);
  assert.doesNotMatch(transformed.argv[2], /subpath "\/private\/tmp\/claude"/u);
  const unexpectedRule = `(allow file-write*\n  (subpath "/etc")\n  (with message "${tag}"))`;
  assert.throws(
    () =>
      transformSandboxRuntimeLaunch({
        ...input,
        launch: {
          ...input.launch,
          argv: [
            "/bin/zsh",
            "-c",
            source.replace("; File write", `; File write\n${unexpectedRule}`),
          ],
        },
      }),
    /unexpected macOS writable subpath remained for \/etc/u,
  );
});

test("fails closed for version, shape, token, and unexpected macOS rule drift", () => {
  const base = {
    launch: { argv: ["/bin/bash", "-c", "not a policy"], env: {} },
    platform: "linux" as const,
    runtimeVersion: SANDBOX_RUNTIME_VERSION,
    jobTempDir: "/tmp/consult-job/temp",
    proxyToken: TOKEN,
    externalHttpPort: 41001,
    externalSocksPort: 41002,
    sharedDefaultWritePaths: ["/tmp/claude", "/private/tmp/claude"],
    allowedWritePaths: ["/tmp/consult-job/home", "/tmp/consult-job/temp"],
  };
  for (const input of [
    { ...base, runtimeVersion: "0.0.65" },
    { ...base, proxyToken: "short" },
    base,
  ]) {
    assert.throws(
      () => transformSandboxRuntimeLaunch(input),
      (error) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === SANDBOX_RUNTIME_POLICY_ERROR,
    );
  }
});

test("shared write-path snapshots include raw and canonical symlink targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consult-srt-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);

  const snapshot = snapshotSandboxRuntimeSharedWritePaths([link]);
  assert.equal(snapshot.includes(link), true);
  assert.equal(snapshot.includes(fs.realpathSync(target)), true);
});
