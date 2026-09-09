import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StartedAgent } from "./acp-client.mts";
import type { JobAuthorityPreflightInput } from "./job-authority-preflight.mts";
import {
  preflightWithClaudeHostRefresh,
  refreshClaudeHostOauth,
} from "./claude-host-auth.mts";

test("refreshClaudeHostOauth initializes one Host session without a prompt", async () => {
  const calls: string[] = [];
  await refreshClaudeHostOauth(input(), {
    startAgent: async (options) => {
      assert.equal(options.binary, "/configured/claude-agent-acp");
      assert.deepEqual(options.args, ["serve"]);
      assert.equal(options.env?.PROFILE_ONLY, "1");
      assert.equal(options.env?.NODE_OPTIONS, undefined);
      assert.match(options.cwd, /^\/tmp\/consult-auth-/);
      assert.equal(options.workspaceRoot, options.cwd);
      assert.equal((await fs.stat(options.cwd)).mode & 0o777, 0o700);
      assert.equal(options.sandbox, "off");
      assert.equal(options.profileRegistryId, "claude");
      calls.push("start");
      return {
        connection: {} as StartedAgent["connection"],
        capabilities: { agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.59.0" } },
        dispose: async () => {
          calls.push("dispose");
        },
      } as StartedAgent;
    },
    newSession: async (_connection, params) => {
      assert.match(params.cwd, /^\/tmp\/consult-auth-/);
      assert.deepEqual(params._meta, { claudeCode: { options: {
        settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true,
        tools: [], plugins: [], persistSession: false,
      } } });
      calls.push("new-session");
      return { sessionId: "auth-refresh-probe" } as never;
    },
  });

  assert.deepEqual(calls, ["start", "new-session", "dispose"]);
});

test("refreshClaudeHostOauth disposes the Profile when initialization fails", async () => {
  let disposed = false;
  await assert.rejects(
    refreshClaudeHostOauth(input(), {
      startAgent: async () => ({
        connection: {} as StartedAgent["connection"],
        capabilities: { agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.59.0" } },
        dispose: async () => {
          disposed = true;
        },
      }) as StartedAgent,
      newSession: async () => {
        throw new Error("authentication required");
      },
    }),
    /authentication required/u,
  );
  assert.equal(disposed, true);
});

test("refreshClaudeHostOauth times out and disposes a stalled Host probe", async () => {
  let disposed = false;
  await assert.rejects(
    refreshClaudeHostOauth(input(), {
      timeoutMs: 5,
      startAgent: async () => ({
        connection: {} as StartedAgent["connection"],
        capabilities: { agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.59.0" } },
        dispose: async () => {
          disposed = true;
        },
      }) as StartedAgent,
      newSession: async () => await new Promise(() => {}),
    }),
    /timed out/u,
  );
  assert.equal(disposed, true);
});

test("expired root Claude preflight refreshes once and reruns exact preflight", async () => {
  const preflightInputs: JobAuthorityPreflightInput[] = [];
  let refreshCalls = 0;
  const result = await preflightWithClaudeHostRefresh(input(), {
    allowHostRefresh: true,
    preflight: async (value) => {
      preflightInputs.push(value);
      return preflightInputs.length === 1 ? expired() : { ok: true, authority: value.authority };
    },
    refresh: async (value) => {
      assert.equal(value, preflightInputs[0]);
      refreshCalls += 1;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(refreshCalls, 1);
  assert.equal(preflightInputs.length, 2);
  assert.equal(preflightInputs[0], preflightInputs[1]);
});

test("Claude refresh is never attempted for nested, non-Claude, or unrelated failures", async () => {
  for (const [value, failure] of [
    [input(), expired()],
    [input({ profileRegistryId: "codex" }), expired()],
    [input(), unrelatedFailure()],
  ] as const) {
    let refreshCalls = 0;
    const result = await preflightWithClaudeHostRefresh(value, {
      allowHostRefresh: value.profileRegistryId === "claude" ? false : true,
      preflight: async () => failure,
      refresh: async () => {
        refreshCalls += 1;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(refreshCalls, 0);
  }
});

test("failed automatic refresh returns stable login remediation without retrying", async () => {
  let preflightCalls = 0;
  const result = await preflightWithClaudeHostRefresh(input(), {
    allowHostRefresh: true,
    preflight: async () => {
      preflightCalls += 1;
      return expired();
    },
    refresh: async () => {
      throw new Error("secret vendor failure detail");
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.diagnostic.message, /automatic Claude Host credential refresh failed/u);
    assert.match(result.diagnostic.remediation, /claude auth login/u);
    assert.doesNotMatch(result.diagnostic.message, /secret vendor failure detail/u);
    assert.equal(result.diagnostic.details?.refreshAttempted, true);
  }
  assert.equal(preflightCalls, 1);
});

test("an unchanged expired credential stops after one refresh and one retry", async () => {
  let preflightCalls = 0;
  let refreshCalls = 0;
  const result = await preflightWithClaudeHostRefresh(input(), {
    allowHostRefresh: true,
    preflight: async () => {
      preflightCalls += 1;
      return expired();
    },
    refresh: async () => {
      refreshCalls += 1;
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.diagnostic.message, /remained expired/u);
    assert.equal(result.diagnostic.details?.refreshAttempted, true);
  }
  assert.equal(preflightCalls, 2);
  assert.equal(refreshCalls, 1);
});

function input(
  overrides: Partial<JobAuthorityPreflightInput> = {},
): JobAuthorityPreflightInput {
  return {
    authority: {
      schemaVersion: 1,
      mode: "read-only",
      confinement: "confined",
      allowFetch: false,
      allowExecute: false,
    },
    workspaceRoot: "/workspace",
    profile: "claude",
    profileRegistryId: "claude",
    profileLaunch: {
      binary: "/configured/claude-agent-acp",
      args: ["serve"],
      env: { PROFILE_ONLY: "1" },
    },
    ...overrides,
  };
}

function expired() {
  return {
    ok: false as const,
    diagnostic: {
      code: "AUTHORITY_PREFLIGHT_FAILED" as const,
      message: "confined authority preflight failed: Claude OAuth credential is expired",
      remediation: "Sign in and retry.",
      details: {
        credentialKind: "claude-oauth",
        credentialState: "expired",
      },
    },
  };
}

function unrelatedFailure() {
  return {
    ok: false as const,
    diagnostic: {
      code: "AUTHORITY_PREFLIGHT_FAILED" as const,
      message: "sandbox dependency failed",
      remediation: "Install the dependency.",
    },
  };
}

test("refresh avoids a synthetic project initialization hook and removes its private cwd", async (t) => {
  const { default: path } = await import("node:path");
  const { default: os } = await import("node:os");
  const { startAgent, newSession } = await import("./acp-client.mts");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-auth-regression-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".claude"), { recursive: true });
  const marker = path.join(root, "hook-ran");
  const transcript = path.join(root, "session.json");
  await fs.writeFile(path.join(workspace, ".claude", "test-hook"), marker);
  const adapter = path.join(root, "adapter.mjs");
  await fs.writeFile(adapter, `
    import fs from 'node:fs';
    import path from 'node:path';
    import readline from 'node:readline';
    const hook = cwd => {
      const file = path.join(cwd, '.claude', 'test-hook');
      if (fs.existsSync(file)) fs.writeFileSync(fs.readFileSync(file, 'utf8'), 'executed');
    };
    hook(process.cwd());
    for await (const line of readline.createInterface({input: process.stdin})) {
      const request = JSON.parse(line);
      let result = {};
      if (request.method === 'initialize') result = {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: {}, agentInfo: {name:'@agentclientprotocol/claude-agent-acp', version:'0.59.0'}
      };
      if (request.method === 'session/new') {
        hook(request.params.cwd);
        fs.writeFileSync(${JSON.stringify(transcript)}, JSON.stringify(request.params));
        result = {sessionId:'probe'};
      }
      if (request.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
    }
  `);
  // Positive control: the old launch context actually reaches the hook sink.
  const control = await startAgent({ binary: process.execPath, args: [adapter], cwd: workspace, sandbox: "off" });
  try { await newSession(control.connection, { cwd: workspace }); } finally { await control.dispose(); }
  assert.equal(await fs.readFile(marker, "utf8"), "executed");
  await fs.unlink(marker);
  await refreshClaudeHostOauth(input({
    workspaceRoot: workspace,
    profileLaunch: { binary: process.execPath, args: [adapter], env: {} },
  }));
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  const session = JSON.parse(await fs.readFile(transcript, "utf8"));
  assert.deepEqual(session._meta.claudeCode.options.settingSources, []);
  assert.equal(session._meta.claudeCode.options.settings.disableAllHooks, true);
  assert.equal(session._meta.claudeCode.options.strictMcpConfig, true);
  assert.notEqual(session.cwd, workspace);
  await assert.rejects(fs.access(session.cwd), { code: "ENOENT" });
});
