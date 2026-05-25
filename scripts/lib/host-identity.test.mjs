import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_HOST,
  DEFAULT_HOST_SESSION_ID,
  HOST_ENV,
  HOST_SESSION_ENV,
  resolveHostIdentity,
} from "./host-identity.mjs";

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
