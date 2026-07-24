import assert from "node:assert/strict";
import { test } from "node:test";

import {
  profileHomeMounts,
  profileLaunchPolicy,
  profileRuntimeMounts,
} from "./profile-launch-policy.mts";

test("profileLaunchPolicy exposes supported live launch policies only", () => {
  assert.ok(profileLaunchPolicy("claude"));
  assert.ok(profileLaunchPolicy("codex"));
  assert.ok(profileLaunchPolicy("grok"));
  assert.equal(profileLaunchPolicy("opencode"), null);
});

test("profileHomeMounts maps claude config into sandbox HOME", () => {
  assert.deepEqual(profileHomeMounts("claude", { HOME: "/host/home" }), [
    {
      source: "/host/home/.claude",
      destination: "/tmp/.claude",
    },
  ]);
});

test("profileHomeMounts maps codex auth files without whole-directory access", () => {
  const mounts = profileHomeMounts("codex", { HOME: "/host/home" });

  assert.deepEqual(mounts, [
    {
      source: "/host/home/.codex/auth.json",
      destination: "/tmp/.codex/auth.json",
    },
    {
      source: "/host/home/.codex/config.toml",
      destination: "/tmp/.codex/config.toml",
    },
    {
      source: "/host/home/.codex/AGENTS.md",
      destination: "/tmp/.codex/AGENTS.md",
    },
  ]);
  assert.equal(mounts.some((mount) => mount.destination === "/tmp/.codex"), false);
});

test("profileHomeMounts maps grok auth files without whole-directory access", () => {
  const mounts = profileHomeMounts("grok", { HOME: "/host/home" });

  assert.deepEqual(mounts, [
    {
      source: "/host/home/.grok/auth.json",
      destination: "/tmp/.grok/auth.json",
    },
    {
      source: "/host/home/.grok/config.toml",
      destination: "/tmp/.grok/config.toml",
    },
  ]);
  assert.equal(mounts.some((mount) => mount.destination === "/tmp/.grok"), false);
  // Grok's MCP OAuth tokens are a separate credential Consult never mounts.
  assert.equal(
    mounts.some((mount) => mount.source.endsWith("mcp_credentials.json")),
    false,
  );
});

test("profiles without specific launch policies add no sandbox mounts", () => {
  assert.deepEqual(profileHomeMounts("opencode", { HOME: "/host/home" }), []);
  assert.deepEqual(profileRuntimeMounts("opencode", { XDG_RUNTIME_DIR: "/run/user/1000" }), []);
});
