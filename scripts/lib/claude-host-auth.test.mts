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
      assert.deepEqual(options.env, { PROFILE_ONLY: "1" });
      assert.equal(options.cwd, "/workspace");
      assert.equal(options.sandbox, "off");
      assert.equal(options.profileRegistryId, "claude");
      calls.push("start");
      return {
        connection: {} as StartedAgent["connection"],
        dispose: async () => {
          calls.push("dispose");
        },
      } as StartedAgent;
    },
    newSession: async (_connection, params) => {
      assert.deepEqual(params, { cwd: "/workspace" });
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
