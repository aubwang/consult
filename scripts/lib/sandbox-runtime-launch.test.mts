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
  MACOS_READ_PATHS,
  acquireConfinedSandboxRuntimeLaunch,
  executableReadScopes,
  inspectMachODependencies,
  isMacosSystemRuntimePath,
  linuxExecutableReadScopes,
  macosExecutableReadScopes,
  parseLinuxLddPaths,
  parseMachOOtoolLoadCommands,
  probeConfinedSandboxRuntime,
} from "./sandbox-runtime-launch.mts";

const TOKEN = "ab".repeat(32);
const NO_PROXY =
  "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

test("macOS system reads exclude the user-managed /usr/local subtree", () => {
  const scopes: readonly string[] = MACOS_READ_PATHS;
  assert.equal(
    scopes.some((scope) =>
      scope === "/usr/local" || "/usr/local".startsWith(`${scope}/`),
    ),
    false,
  );
  for (const required of ["/usr/bin", "/usr/lib", "/usr/libexec", "/usr/sbin", "/usr/share"]) {
    assert.ok(scopes.includes(required));
  }
  assert.equal(isMacosSystemRuntimePath("/usr/local/lib/libcustom.dylib"), false);
  assert.equal(isMacosSystemRuntimePath("/usr/lib/libSystem.B.dylib"), true);
});

test("Mach-O load command parsing keeps dependencies, weak links, and rpaths", () => {
  assert.deepEqual(parseMachOOtoolLoadCommands(`
Load command 11
          cmd LC_RPATH
      cmdsize 40
         path @loader_path/../lib (offset 12)
Load command 12
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name @rpath/libexample.dylib (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 1.0.0
compatibility version 1.0.0
Load command 13
          cmd LC_LOAD_WEAK_DYLIB
      cmdsize 64
         name @loader_path/liboptional.dylib (offset 24)
`), {
    dependencies: [
      { installName: "@rpath/libexample.dylib", weak: false },
      { installName: "@loader_path/liboptional.dylib", weak: true },
    ],
    rpaths: ["@loader_path/../lib"],
  });
});

test("macOS executable scopes resolve rpaths and tolerate missing weak links", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-macho-scopes-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "bin", "agent");
  const dependency = path.join(root, "lib", "libexample.dylib");
  await Promise.all([
    fsp.mkdir(path.dirname(executable), { recursive: true }),
    fsp.mkdir(path.dirname(dependency), { recursive: true }),
  ]);
  const machOMagic = Buffer.from("feedfacf", "hex");
  await Promise.all([
    fsp.writeFile(executable, machOMagic),
    fsp.writeFile(dependency, machOMagic),
  ]);
  const warnings: string[] = [];
  const inspected: string[] = [];

  const scopes = macosExecutableReadScopes(executable, (candidate) => {
    inspected.push(candidate);
    return candidate === executable
      ? {
          dependencies: [
            { installName: "@rpath/libexample.dylib", weak: false },
            { installName: "@loader_path/liboptional.dylib", weak: true },
          ],
          rpaths: ["@loader_path/../lib"],
        }
      : { dependencies: [], rpaths: [] };
  }, (message) => warnings.push(message));

  assert.ok(scopes.includes(dependency));
  assert.deepEqual(inspected, [executable, dependency]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing weak-linked macOS runtime dependency/u);
});

test("missing otool reports the Xcode Command Line Tools remediation", async (t) => {
  if (process.platform === "darwin") {
    t.skip("the real macOS runner supplies /usr/bin/otool");
    return;
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-missing-otool-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "agent");
  await fsp.writeFile(executable, Buffer.from("feedfacf", "hex"));

  assert.throws(
    () => inspectMachODependencies(executable),
    /install Xcode Command Line Tools with 'xcode-select --install'/u,
  );
});

test("executable read scopes include only linked Homebrew runtime packages", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-homebrew-scopes-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nodePackage = path.join(root, "Cellar", "node@24", "24.18.0");
  const libuvPackage = path.join(root, "Cellar", "libuv", "1.51.0");
  const opensslPackage = path.join(root, "Cellar", "openssl@3", "3.5.1");
  const libuvAlias = path.join(root, "opt", "libuv");
  const opensslAlias = path.join(root, "opt", "openssl@3");
  const caBundle = path.join(root, "etc", "ca-certificates", "cert.pem");
  const opensslCaAlias = path.join(root, "etc", "openssl@3", "cert.pem");
  await Promise.all([
    fsp.mkdir(path.join(nodePackage, "bin"), { recursive: true }),
    fsp.mkdir(path.join(libuvPackage, "lib"), { recursive: true }),
    fsp.mkdir(path.join(opensslPackage, "lib"), { recursive: true }),
    fsp.mkdir(path.join(root, "opt"), { recursive: true }),
    fsp.mkdir(path.dirname(caBundle), { recursive: true }),
    fsp.mkdir(path.dirname(opensslCaAlias), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(nodePackage, "bin", "node"), ""),
    fsp.writeFile(path.join(libuvPackage, "lib", "libuv.1.dylib"), ""),
    fsp.writeFile(path.join(opensslPackage, "lib", "libcrypto.3.dylib"), ""),
    fsp.writeFile(caBundle, "fixture CA bundle"),
    fsp.symlink(libuvPackage, libuvAlias),
    fsp.symlink(opensslPackage, opensslAlias),
    fsp.symlink(path.relative(path.dirname(opensslCaAlias), caBundle), opensslCaAlias),
  ]);
  const executable = path.join(nodePackage, "bin", "node");
  const scopes = executableReadScopes(executable, [
    path.join(libuvAlias, "lib", "libuv.1.dylib"),
    path.join(libuvPackage, "lib", "libuv.1.dylib"),
    path.join(opensslAlias, "lib", "libcrypto.3.dylib"),
    path.join(opensslPackage, "lib", "libcrypto.3.dylib"),
  ]);

  assert.ok(scopes.includes(nodePackage));
  assert.ok(scopes.includes(libuvAlias));
  assert.ok(scopes.includes(libuvPackage));
  assert.ok(scopes.includes(opensslAlias));
  assert.ok(scopes.includes(opensslPackage));
  assert.ok(scopes.includes(caBundle));
  assert.ok(scopes.includes(opensslCaAlias));
  assert.equal(scopes.includes(path.dirname(caBundle)), false);
  assert.equal(scopes.includes(root), false);
  assert.equal(scopes.includes(path.join(root, "opt")), false);
  assert.equal(scopes.includes(path.join(root, "Cellar")), false);
});

test("macOS x64 Homebrew scopes do not widen to /usr/local", () => {
  const scopes = executableReadScopes(
    "/usr/local/Cellar/node@24/24.18.0/bin/node",
    [
      "/usr/local/opt/libuv/lib/libuv.1.dylib",
      "/usr/local/Cellar/libuv/1.51.0/lib/libuv.1.dylib",
    ],
  );

  assert.ok(scopes.includes("/usr/local/Cellar/node@24/24.18.0"));
  assert.ok(scopes.includes("/usr/local/opt/libuv/lib"));
  assert.ok(scopes.includes("/usr/local/Cellar/libuv/1.51.0"));
  assert.equal(scopes.includes("/usr/local"), false);
  assert.equal(scopes.includes("/usr/local/Cellar"), false);
  assert.equal(scopes.includes("/usr/local/opt"), false);
});

test("Linux executable scopes include exact Homebrew ELF dependencies without broad roots", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-linuxbrew-scopes-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nodePackage = path.join(root, "Cellar", "node", "26.5.0");
  const zlibPackage = path.join(root, "Cellar", "zlib-ng-compat", "2.2.4");
  const glibcPackage = path.join(root, "Cellar", "glibc", "2.39");
  const executable = path.join(nodePackage, "bin", "node");
  const zlib = path.join(zlibPackage, "lib", "libz.so.1.3");
  const zlibAlias = path.join(root, "opt", "zlib-ng-compat");
  const zlibSoname = path.join(zlibAlias, "lib", "libz.so.1");
  const loader = path.join(glibcPackage, "lib", "ld-linux-x86-64.so.2");
  const loaderAlias = path.join(root, "lib", "ld.so");
  await Promise.all([
    fsp.mkdir(path.dirname(executable), { recursive: true }),
    fsp.mkdir(path.dirname(zlib), { recursive: true }),
    fsp.mkdir(path.dirname(loader), { recursive: true }),
    fsp.mkdir(path.join(root, "opt"), { recursive: true }),
    fsp.mkdir(path.join(root, "lib"), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(executable, ""),
    fsp.writeFile(zlib, ""),
    fsp.writeFile(loader, ""),
    fsp.symlink(zlibPackage, zlibAlias),
    fsp.symlink("libz.so.1.3", path.join(zlibPackage, "lib", "libz.so.1")),
    fsp.symlink(path.relative(path.dirname(loaderAlias), loader), loaderAlias),
  ]);

  const scopes = linuxExecutableReadScopes(executable, [zlibSoname, loaderAlias]);

  assert.ok(scopes.includes(nodePackage));
  assert.ok(scopes.includes(zlibSoname));
  assert.ok(scopes.includes(zlibAlias));
  assert.ok(scopes.includes(zlibPackage));
  assert.ok(scopes.includes(loaderAlias));
  assert.ok(scopes.includes(glibcPackage));
  assert.equal(scopes.includes(root), false);
  assert.equal(scopes.includes(path.join(root, "Cellar")), false);
  assert.equal(scopes.includes(path.join(root, "opt")), false);
  assert.equal(scopes.includes(path.join(root, "lib")), false);
});

test("Linux ldd parsing keeps only absolute dependency paths", () => {
  assert.deepEqual(parseLinuxLddPaths(`
linux-vdso.so.1 (0x00007fff)
libnode.so.147 => /home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/lib/libnode.so.147 (0x1)
libnode-dot.so => /home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/bin/../lib/libnode-dot.so (0x1)
libmissing.so => not found
/home/linuxbrew/.linuxbrew/lib/ld.so => /lib64/ld-linux-x86-64.so.2 (0x2)
statically linked
`), [
    "/home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/lib/libnode.so.147",
    "/home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/lib/libnode-dot.so",
    "/home/linuxbrew/.linuxbrew/lib/ld.so",
    "/lib64/ld-linux-x86-64.so.2",
  ]);
});

test("confined Codex launch keeps auth.json when OPENAI_API_KEY is only ambient", async (t) => {
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
      OPENAI_API_KEY: "project-key",
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
      lease.launch.args[1].includes(`http://consult:${TOKEN}@127.0.0.1:3128`),
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
    await assert.rejects(
      fsp.access(path.join(stagedHome, "..", "bin", "codex")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.ok(harness.configs[0].filesystem.allowRead.includes(stagedHome));
    assert.ok(harness.configs[0].filesystem.allowRead.includes(lease.launch.env.TMPDIR));
    assert.ok(harness.configs[0].filesystem.allowRead.includes("/bin"));
    assert.ok(harness.configs[0].filesystem.allowRead.includes(fs.realpathSync("/bin")));
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

test("confined Codex launch uses CONSULT_OPENAI_API_KEY instead of auth.json", async (t) => {
  const fixture = await makeFixture(t);
  const sourceAuth = path.join(fixture.home, ".codex", "auth.json");
  await privateFile(sourceAuth, '{"token":"host-only"}');
  const harness = fakeRuntime();

  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      CONSULT_OPENAI_API_KEY: "explicit-key",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "codex",
  }, harness.deps);

  try {
    assert.equal(lease.launch.env.OPENAI_API_KEY, "explicit-key");
    await assert.rejects(
      fsp.access(path.join(lease.launch.env.CODEX_HOME!, "auth.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await lease.release();
  }
});

test("confined Claude launch rejects ambiguous Consult credentials before runtime startup", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      args: [],
      cwd: fixture.workspace,
      env: {
        PATH: "/usr/bin:/bin",
        CONSULT_CLAUDE_API_KEY: "api-key",
        CONSULT_CLAUDE_OAUTH_TOKEN: "oauth-token",
      },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "claude",
    }, harness.deps),
    /multiple Consult credential variables are set for confined claude Profile/u,
  );
  assert.deepEqual(harness.events, []);
});

test("confined launch maps a Consult credential into the vendor environment", async (t) => {
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
      CONSULT_OPENAI_API_KEY: "selected-key",
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

test("confined launch does not use an ambient vendor API key when no credential file exists", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      args: [],
      cwd: fixture.workspace,
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        CODEX_HOME: path.join(fixture.home, ".codex"),
        OPENAI_API_KEY: "project-key",
      },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "codex",
    }, harness.deps),
    /no staged credential or Consult credential environment variable/u,
  );
});

test("write and fetch authority only broaden Workspace writes and public TCP/443 proxying", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority({ mode: "write", allowFetch: true }),
    binary: "/usr/bin/true",
    cwd: fixture.workspace,
    env: {
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      CODEX_HOME: path.join(fixture.home, ".codex"),
      CONSULT_OPENAI_API_KEY: "selected-key",
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
      fs.realpathSync(fixture.workspace),
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
        env: { CONSULT_OPENAI_API_KEY: "selected-key", PATH: "/usr/bin:/bin" },
        workspaceRoot: fixture.workspace,
        mode: "read-only",
        profileRegistryId,
      }, harness.deps),
      /confined authority is unsupported for Profile registry identity/u,
    );
    assert.deepEqual(harness.events, []);
  }
});

test("macOS x64 processes fail before runtime or proxy startup", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      cwd: fixture.workspace,
      env: { CONSULT_OPENAI_API_KEY: "selected-key", PATH: "/usr/bin:/bin" },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "codex",
    }, { ...harness.deps, platform: "darwin", arch: "x64" }),
    /unsupported for a macOS x64 process/u,
  );
  assert.deepEqual(harness.events, []);
});

test("confined preflight reports macOS x64 as platform-unsupported", async (t) => {
  const fixture = await makeFixture(t);
  const result = await probeConfinedSandboxRuntime({
    authority: authority(),
    workspaceRoot: fixture.workspace,
    profile: "codex",
    profileRegistryId: "codex",
    profileLaunch: { binary: "/configured/codex-acp", args: [], env: {} },
    platform: "darwin",
    arch: "x64",
  }, {
    startAgent: async () => {
      throw new Error("Profile launch must not be reached");
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "AUTHORITY_PLATFORM_UNSUPPORTED");
    assert.match(result.diagnostic.message, /macOS x64 process/u);
  }
});

test("confined launch rejects Workspace glob metacharacters before runtime startup", async (t) => {
  const fixture = await makeFixture(t);
  const workspace = path.join(fixture.root, "workspace[1]");
  await fsp.mkdir(workspace);
  const harness = fakeRuntime();
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      cwd: workspace,
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        CONSULT_OPENAI_API_KEY: "selected-key",
      },
      workspaceRoot: workspace,
      mode: "read-only",
      profileRegistryId: "codex",
    }, harness.deps),
    /Workspace path contains glob metacharacters/u,
  );
  assert.deepEqual(harness.events, []);
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
        CONSULT_OPENAI_API_KEY: "selected-key",
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

test("confined preflight reports stable nested sandbox diagnostics without relaying Profile stderr", async (t) => {
  const fixture = await makeFixture(t);
  for (const [stderr, expected] of [
    [
      "sandbox-exec: sandbox_apply: Operation not permitted\nsecret-profile-output",
      /nested macOS sandbox initialization failed/u,
    ],
    [
      "bwrap: Creating new namespace failed: Operation not permitted\nsecret-profile-output",
      /nested Linux sandbox initialization failed/u,
    ],
  ] as const) {
    const error = Object.assign(new Error("Agent exited before initialize completed"), {
      stderr,
    });
    const result = await probeConfinedSandboxRuntime({
      authority: authority(),
      workspaceRoot: fixture.workspace,
      profile: "codex",
      profileRegistryId: "codex",
      profileLaunch: { binary: "/configured/codex-acp", args: [], env: {} },
    }, {
      platform: "linux",
      startAgent: async () => {
        throw error;
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.diagnostic.message, expected);
      assert.doesNotMatch(result.diagnostic.message, /secret-profile-output/u);
    }
  }
});

test("dependency failures preserve actionable messages", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime({
    dependencies: {
      errors: ["bwrap not found on PATH"],
      warnings: ["socat version is unverified"],
    },
  });

  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      cwd: fixture.workspace,
      env: { CONSULT_OPENAI_API_KEY: "selected-key", PATH: "/usr/bin:/bin" },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "codex",
    }, harness.deps),
    /error: bwrap not found on PATH; warning: socat version is unverified/u,
  );
  assert.deepEqual(harness.events, []);
});

test("confined claude launch rejects expired OAuth credential before runtime or proxy startup", async (t) => {
  const fixture = await makeFixture(t);
  const now = 2_000_000_000_000;
  const sourceCredential = path.join(fixture.home, ".claude", ".credentials.json");
  await privateFile(
    sourceCredential,
    JSON.stringify({
      claudeAiOauth: { accessToken: "REDACTED", expiresAt: now - 60_000 },
    }),
  );
  const harness = fakeRuntime();
  await assert.rejects(
    acquireConfinedSandboxRuntimeLaunch({
      authority: authority(),
      binary: "/usr/bin/true",
      args: [],
      cwd: fixture.workspace,
      env: { PATH: "/usr/bin:/bin" },
      workspaceRoot: fixture.workspace,
      mode: "read-only",
      profileRegistryId: "claude",
    }, { ...harness.deps, now: () => now }),
    /Claude OAuth credential is expired/u,
  );
  assert.deepEqual(harness.events, []);
});

test("confined Claude launch uses CONSULT_CLAUDE_OAUTH_TOKEN despite an expired OAuth file", async (t) => {
  const fixture = await makeFixture(t);
  const now = 2_000_000_000_000;
  const sourceCredential = path.join(fixture.home, ".claude", ".credentials.json");
  await privateFile(
    sourceCredential,
    JSON.stringify({
      claudeAiOauth: { accessToken: "REDACTED", expiresAt: now - 60_000 },
    }),
  );
  const harness = fakeRuntime();

  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: "/usr/bin:/bin",
      CONSULT_CLAUDE_OAUTH_TOKEN: "explicit-token",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "claude",
  }, { ...harness.deps, now: () => now });

  try {
    assert.equal(lease.launch.env.CLAUDE_CODE_OAUTH_TOKEN, "explicit-token");
    await assert.rejects(
      fsp.access(path.join(lease.launch.env.CLAUDE_CONFIG_DIR!, ".credentials.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await lease.release();
  }
});

test("confined Claude launch maps CONSULT_CLAUDE_API_KEY to ANTHROPIC_API_KEY", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: "/usr/bin:/bin",
      CONSULT_CLAUDE_API_KEY: "explicit-key",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "claude",
  }, harness.deps);

  try {
    assert.equal(lease.launch.env.ANTHROPIC_API_KEY, "explicit-key");
    assert.equal(lease.launch.env.CONSULT_CLAUDE_API_KEY, undefined);
  } finally {
    await lease.release();
  }
});

test("confined Claude launch transports only the explicit requested model", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: "/usr/bin:/bin",
      CONSULT_CLAUDE_API_KEY: "explicit-key",
      ANTHROPIC_MODEL: "ambient-model",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "claude",
    requestedModel: "claude-fable-5",
  }, harness.deps);

  try {
    assert.equal(lease.launch.env.ANTHROPIC_MODEL, "claude-fable-5");
  } finally {
    await lease.release();
  }
});

test("confined Claude launch drops an ambient model when none was requested", async (t) => {
  const fixture = await makeFixture(t);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    args: [],
    cwd: fixture.workspace,
    env: {
      PATH: "/usr/bin:/bin",
      CONSULT_CLAUDE_API_KEY: "explicit-key",
      ANTHROPIC_MODEL: "ambient-model",
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "claude",
  }, harness.deps);

  try {
    assert.equal(lease.launch.env.ANTHROPIC_MODEL, undefined);
  } finally {
    await lease.release();
  }
});

test("confined preflight surfaces a specific re-authentication remediation for expired Claude OAuth", async (t) => {
  const fixture = await makeFixture(t);
  const now = 2_000_000_000_000;
  const sourceCredential = path.join(fixture.home, ".claude", ".credentials.json");
  await privateFile(
    sourceCredential,
    JSON.stringify({
      claudeAiOauth: { accessToken: "REDACTED", expiresAt: now - 60_000 },
    }),
  );
  const harness = fakeRuntime();
  const result = await probeConfinedSandboxRuntime({
    authority: authority(),
    workspaceRoot: fixture.workspace,
    profile: "claude",
    profileRegistryId: "claude",
    profileLaunch: { binary: "/usr/bin/true", args: [], env: {} },
  }, { ...harness.deps, now: () => now });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "AUTHORITY_PREFLIGHT_FAILED");
    assert.match(result.diagnostic.message, /Claude OAuth credential is expired/u);
    assert.deepEqual(result.diagnostic.details, {
      credentialKind: "claude-oauth",
      credentialState: "expired",
    });
    assert.match(result.diagnostic.remediation, /automatically refreshes/iu);
    assert.match(result.diagnostic.remediation, /CONSULT_CLAUDE_OAUTH_TOKEN/u);
    assert.match(result.diagnostic.remediation, /Nested invocations cannot mutate Host credentials/iu);
    assert.doesNotMatch(result.diagnostic.remediation, /consult doctor/u);
  }
  assert.deepEqual(harness.events, []);
});

test("a new confined launch sweeps an old root whose owner is gone", async (t) => {
  const fixture = await makeFixture(t);
  const staleRoot = await fsp.mkdtemp("/tmp/consult-srt-job-stale-");
  t.after(() => fsp.rm(staleRoot, { recursive: true, force: true }));
  await fsp.writeFile(
    path.join(staleRoot, ".consult-owner.json"),
    `${JSON.stringify({ pid: 999_999, createdAt: 0 })}\n`,
    { mode: 0o600 },
  );
  const now = Date.now();
  const old = new Date(now - 40 * 60 * 1000);
  await fsp.utimes(staleRoot, old, old);
  const harness = fakeRuntime();
  const lease = await acquireConfinedSandboxRuntimeLaunch({
    authority: authority(),
    binary: "/usr/bin/true",
    cwd: fixture.workspace,
    env: {
      CONSULT_OPENAI_API_KEY: "selected-key",
      PATH: `${fixture.bin}:/usr/bin:/bin`,
    },
    workspaceRoot: fixture.workspace,
    mode: "read-only",
    profileRegistryId: "codex",
  }, {
    ...harness.deps,
    now: () => now,
    pidIsAlive: () => false,
  });
  try {
    assert.equal(fs.existsSync(staleRoot), false);
  } finally {
    await lease.release();
  }
});

function fakeRuntime(options: {
  invalidArtifact?: boolean;
  dependencies?: { errors: string[]; warnings: string[] };
} = {}) {
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
        checkDependencies: () => options.dependencies ?? ({ errors: [], warnings: [] }),
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
    "--tmpfs /home --tmpfs /root --tmpfs /var --tmpfs /etc",
    "--bind /tmp/claude-http-0123456789abcdef.sock /tmp/claude-http-0123456789abcdef.sock",
    "--bind /tmp/claude-socks-fedcba9876543210.sock /tmp/claude-socks-fedcba9876543210.sock",
    "--bind /tmp/claude /tmp/claude",
    "--tmpfs /tmp",
    "--unshare-pid --proc /proc -- /bin/bash -c /vendor/seccomp/x64/apply-seccomp",
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
