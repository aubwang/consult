import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { StartedAgent } from "./acp-client.mts";
import type { EgressProxyOptions } from "./egress-proxy.mts";
import type { JobAuthority } from "./job-authority.mts";
import {
  CONFINED_PROFILE_POLICIES,
  acquireConfinedSandboxRuntimeLaunch,
  probeConfinedSandboxRuntime,
} from "./sandbox-runtime-launch.mts";

const TOKEN = "ab".repeat(32);
const NO_PROXY =
  "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

test("confined launch stages minimal Codex state, sanitizes env, and removes Job state", async (t) => {
  const fixture = await makeFixture(t);
  const sourceAuth = path.join(fixture.home, ".codex", "auth.json");
  const sourceConfig = path.join(fixture.home, ".codex", "config.toml");
  await privateFile(sourceAuth, '{"token":"host-only"}');
  await privateFile(sourceConfig, "model = 'configured'");
  const harness = fakeRuntime();

  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: ["argument with spaces"],
    cwd: fixture.workspace,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      CODEX_HOME: path.join(fixture.home, ".codex"),
      OPENAI_API_KEY: "selected-key",
      GH_TOKEN: "must-not-leak",
      OP_SERVICE_ACCOUNT_TOKEN: "must-not-leak",
      HTTP_PROXY: "http://ambient.invalid",
      CONSULT_PARENT_JOB: "parent-job",
      CONSULT_WORKSPACE: fixture.workspace,
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    sandbox: "off",
    profileRegistryId: "codex",
  }, harness.deps);

  const stagedHome = lease.launch.env.HOME!;
  try {
    assert.equal(
      await fsp.readFile(path.join(stagedHome, ".codex", "auth.json"), "utf8"),
      '{"token":"host-only"}',
    );
    await assert.rejects(
      fsp.access(path.join(stagedHome, ".codex", "config.toml")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.equal(lease.launch.env.OPENAI_API_KEY, undefined);
    assert.equal(lease.launch.env.GH_TOKEN, undefined);
    assert.equal(lease.launch.env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.equal(lease.launch.env.HTTP_PROXY, undefined);
    assert.equal(lease.launch.env.CONSULT_PARENT_JOB, "parent-job");
    assert.equal(lease.launch.env.HOME, lease.launch.env.CODEX_HOME?.replace(/\/\.codex$/u, ""));
    assert.ok(
      lease.launch.args[1].includes(`http://consult:${TOKEN}@localhost:3128`),
    );
    assert.match(harness.commands[0], /argument with spaces/u);

    assert.deepEqual(harness.proxyOptions, [{
      trustedHosts: CONFINED_PROFILE_POLICIES.codex.trustedHosts,
      allowPublicHosts: false,
    }]);
    assert.deepEqual(harness.configs[0].filesystem.denyRead, ["/"]);
    assert.ok(
      harness.configs[0].filesystem.allowRead.some((entry: string) =>
        entry.includes("/node_modules/@anthropic-ai/sandbox-runtime")),
    );
    assert.ok(harness.configs[0].filesystem.allowRead.includes(path.join(stagedHome, "..", "bin")));
    assert.equal(
      harness.configs[0].filesystem.allowRead.includes(path.dirname(stagedHome)),
      false,
    );
    assert.deepEqual(harness.configs[0].filesystem.allowWrite, [
      stagedHome,
      lease.launch.env.TMPDIR,
    ]);
    assert.equal(harness.configs[0].network.strictAllowlist, true);
    assert.deepEqual(harness.configs[0].network.deniedDomains, ["*"]);

    await fsp.writeFile(path.join(stagedHome, ".codex", "auth.json"), "changed");
  } finally {
    await Promise.all([lease.release(), lease.release()]);
  }

  assert.equal(await fsp.readFile(sourceAuth, "utf8"), '{"token":"host-only"}');
  assert.equal(fs.existsSync(stagedHome), false);
  assert.deepEqual(harness.events, ["initialize", "wrap", "cleanup", "reset", "proxy-close"]);
});

test("confined launch falls back to one credential environment variable", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      CODEX_HOME: path.join(fixture.home, ".codex"),
      OPENAI_API_KEY: "selected-key",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "codex",
  }, harness.deps);

  try {
    assert.equal(lease.launch.env.OPENAI_API_KEY, "selected-key");
    await assert.rejects(
      fsp.access(path.join(lease.launch.env.CODEX_HOME!, "auth.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await lease.release();
  }
});

test("write and fetch authority only broaden Workspace writes and public HTTPS proxying", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority({ mode: "write", allowFetch: true }),
    binary: "/usr/bin/true",
    cwd: fixture.workspace,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      CODEX_HOME: path.join(fixture.home, ".codex"),
      OPENAI_API_KEY: "selected-key",
    },
    workspaceRoot: fixture.workspace,
    mode: "write",
    profileRegistryId: "codex",
  }, harness.deps);

  try {
    assert.equal(harness.proxyOptions[0].allowPublicHosts, true);
    assert.deepEqual(harness.configs[0].filesystem.allowWrite, [
      lease.launch.env.HOME,
      lease.launch.env.TMPDIR,
      fixture.workspace,
    ]);
  } finally {
    await lease.release();
  }
});

test("custom and opencode confined Profiles fail before runtime or proxy startup", async (t) => {
  const fixture = await makeFixture(t);
  for (const profileRegistryId of [undefined, "opencode"]) {
    const harness = fakeRuntime();
    await assert.rejects(
      acquireConfinedSandboxRuntimeLaunch({
        authority: authority(),
        binary: "/usr/bin/true",
        cwd: fixture.workspace,
        env: { OPENAI_API_KEY: "selected-key", PATH: "/usr/bin:/bin" },
        workspaceRoot: fixture.workspace,
        mode: "read-only",
        profileRegistryId,
      }, harness.deps),
      /confined authority is unsupported for Profile registry identity/u,
    );
    assert.deepEqual(harness.events, []);
  }
});

test("generated-policy rejection cleans the manager, proxy, and temporary Job root", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime({ invalidArtifact: true });
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      cwd: fixture.workspace,
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        CODEX_HOME: path.join(fixture.home, ".codex"),
        OPENAI_API_KEY: "selected-key",
      },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "codex",
    }, harness.deps),
    /Sandbox Runtime policy rejected/u,
  );

  const jobHome = harness.configs[0].filesystem.allowWrite[0];
  assert.equal(fs.existsSync(jobHome), false);
  assert.deepEqual(harness.events, ["initialize", "wrap", "cleanup", "reset", "proxy-close"]);
});

test("confined preflight initializes and disposes the exact configured Profile", async (t) => {
  const fixture = await makeFixture(t);
  let disposed = false;
  const result = await probeConfinedSandboxRuntime({
    authority: authority(),
    workspaceRoot: fixture.workspace,
    profile: "codex-alias",
    profileRegistryId: "codex",
    profileLaunch: {
      binary: "/configured/codex-acp",
      args: ["serve"],
      env: { PROFILE_ONLY: "1" },
    },
  }, {
    platform: "linux",
    startAgent: async (options, deps) => {
      assert.equal(options.binary, "/configured/codex-acp");
      assert.deepEqual(options.args, ["serve"]);
      assert.equal(options.env?.PROFILE_ONLY, "1");
      assert.equal(options.profileRegistryId, "codex");
      assert.ok(deps?.acquireLaunch);
      return {
        dispose: async () => {
          disposed = true;
        },
      } as StartedAgent;
    },
  });

  assert.deepEqual(result, { ok: true, authority: authority() });
  assert.equal(disposed, true);
});

test("confined preflight fails closed without an exact Profile launch", async (t) => {
  const fixture = await makeFixture(t);
  const result = await probeConfinedSandboxRuntime({
    authority: authority(),
    workspaceRoot: fixture.workspace,
    profile: "codex",
    profileRegistryId: "codex",
  }, { platform: "linux" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "AUTHORITY_COMBINATION_UNSUPPORTED");
    assert.match(result.diagnostic.message, /exact 'codex' Profile launch/u);
  }
});

function fakeRuntime(options: { invalidArtifact?: boolean } = {}) {
  const events: string[] = [];
  const configs: any[] = [];
  const commands: string[] = [];
  const proxyOptions: EgressProxyOptions[] = [];
  return {
    events,
    configs,
    commands,
    proxyOptions,
    deps: {
      platform: "linux" as const,
      manager: {
        isSupportedPlatform: () => true,
        checkDependencies: () => ({ errors: [], warnings: [] }),
        async initialize(config: any) {
          events.push("initialize");
          configs.push(config);
        },
        async wrapWithSandboxArgv(command: string) {
          events.push("wrap");
          commands.push(command);
          return options.invalidArtifact
            ? { argv: ["/bin/bash", "-c", "unexpected"], env: {} }
            : { argv: ["/bin/bash", "-c", linuxArtifact()], env: {} };
        },
        cleanupAfterCommand() {
          events.push("cleanup");
        },
        async reset() {
          events.push("reset");
        },
      },
      async startProxy(value: EgressProxyOptions) {
        proxyOptions.push(value);
        return {
          httpPort: 41_001,
          socksPort: 41_002,
          token: TOKEN,
          async close() {
            events.push("proxy-close");
          },
        };
      },
    },
  };
}

function linuxArtifact(): string {
  return [
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
    "--bind /tmp/claude-http-0123456789abcdef.sock /tmp/claude-http-0123456789abcdef.sock",
    "--bind /tmp/claude-socks-fedcba9876543210.sock /tmp/claude-socks-fedcba9876543210.sock",
    "--bind /tmp/claude /tmp/claude",
    "--tmpfs /tmp",
    "--unshare-pid --proc /proc -- /bin/bash -c agent",
  ].join(" ");
}

function authority(
  overrides: Partial<JobAuthority> = {},
): JobAuthority {
  return {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "confined",
    allowFetch: false,
    allowExecute: false,
    ...overrides,
  };
}

async function makeFixture(t: TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-srt-launch-test-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  await Promise.all([
    fsp.mkdir(home, { recursive: true }),
    fsp.mkdir(workspace, { recursive: true }),
    fsp.mkdir(bin, { recursive: true }),
  ]);
  const codex = path.join(bin, "codex");
  await fsp.writeFile(codex, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, home, workspace, bin };
}

async function privateFile(file: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, contents, { mode: 0o600 });
}
