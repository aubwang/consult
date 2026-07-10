import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_HOST,
  DEFAULT_HOST_SESSION_ID,
  HOST_ENV,
  HOST_SESSION_ENV,
  resolveHostIdentity,
} from "./host-identity.mts";

test("resolveHostIdentity uses defaults when args and env are absent", () => {
  assert.deepEqual(resolveHostIdentity({ env: {} }), {
    host: DEFAULT_HOST,
    hostSessionId: DEFAULT_HOST_SESSION_ID,
  });
});

test("resolveHostIdentity lets flags override env", () => {
  assert.deepEqual(
    resolveHostIdentity({
      args: {
        flags: {
          host: "codex",
          "host-session-id": "flag-session",
        },
      },
      env: {
        [HOST_ENV]: "claude-code",
        [HOST_SESSION_ENV]: "env-session",
      },
    }),
    {
      host: "codex",
      hostSessionId: "flag-session",
    },
  );
});

test("resolveHostIdentity lets consult env override host autodetection", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        [HOST_ENV]: "manual-host",
        [HOST_SESSION_ENV]: "manual-session",
        OPENCODE_RUN_ID: "opencode-run",
        CODEX_THREAD_ID: "codex-thread",
      },
    }),
    {
      host: "manual-host",
      hostSessionId: "manual-session",
    },
  );
});

test("resolveHostIdentity detects opencode from session env", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        OPENCODE_SESSION_ID: "opencode-session",
        OPENCODE_RUN_ID: "opencode-run",
      },
    }),
    {
      host: "opencode",
      hostSessionId: "opencode-session",
    },
  );
});

test("resolveHostIdentity detects opencode from run env", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        OPENCODE_RUN_ID: "opencode-run",
      },
    }),
    {
      host: "opencode",
      hostSessionId: "opencode-run",
    },
  );
});

test("resolveHostIdentity detects codex from thread env", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        CODEX_THREAD_ID: "codex-thread",
      },
    }),
    {
      host: "codex",
      hostSessionId: "codex-thread",
    },
  );
});

test("resolveHostIdentity ignores Claude Code session env", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        CLAUDE_SESSION_ID: "claude-session",
      },
    }),
    {
      host: DEFAULT_HOST,
      hostSessionId: DEFAULT_HOST_SESSION_ID,
    },
  );
});

test("resolveHostIdentity prefers the most local known host signal", () => {
  assert.deepEqual(
    resolveHostIdentity({
      env: {
        OPENCODE_RUN_ID: "opencode-run",
        CODEX_THREAD_ID: "codex-thread",
      },
    }),
    {
      host: "opencode",
      hostSessionId: "opencode-run",
    },
  );
});
