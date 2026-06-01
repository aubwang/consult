import assert from "node:assert/strict";
import { test } from "node:test";

import {
  profileHomeMounts,
  profileLaunchPolicy,
  profileRuntimeMounts,
} from "./profile-launch-policy.mjs";

test("profileLaunchPolicy exposes supported live launch policies only", () => {
  assert.ok(profileLaunchPolicy("claude"));
  assert.ok(profileLaunchPolicy("codex"));
  assert.ok(profileLaunchPolicy("gemini"));
  assert.equal(profileLaunchPolicy("opencode"), null);
  assert.equal(profileLaunchPolicy("copilot"), null);
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

test("profiles without specific launch policies add no sandbox mounts", () => {
  assert.deepEqual(profileHomeMounts("opencode", { HOME: "/host/home" }), []);
  assert.deepEqual(profileRuntimeMounts("opencode", { XDG_RUNTIME_DIR: "/run/user/1000" }), []);
  assert.deepEqual(profileHomeMounts("copilot", { HOME: "/host/home" }), []);
  assert.deepEqual(profileRuntimeMounts("copilot", { XDG_RUNTIME_DIR: "/run/user/1000" }), []);
});

test("profileHomeMounts maps Gemini auth files without whole-directory access", () => {
  const mounts = profileHomeMounts("gemini", { HOME: "/host/home" });

  assert.deepEqual(mounts, [
    {
      source: "/host/home/.gemini/settings.json",
      destination: "/tmp/.gemini/settings.json",
    },
    {
      source: "/host/home/.gemini/oauth_creds.json",
      destination: "/tmp/.gemini/oauth_creds.json",
    },
    {
      source: "/host/home/.gemini/GEMINI.md",
      destination: "/tmp/.gemini/GEMINI.md",
    },
    {
      source: "/host/home/.gemini/mcp-oauth-tokens.json",
      destination: "/tmp/.gemini/mcp-oauth-tokens.json",
    },
    {
      source: "/host/home/.gemini/a2a-oauth-tokens.json",
      destination: "/tmp/.gemini/a2a-oauth-tokens.json",
    },
  ]);
  assert.equal(mounts.some((mount) => mount.destination === "/tmp/.gemini"), false);
});

test("profileRuntimeMounts maps Gemini ADC credentials as an absolute read-only mount", () => {
  assert.deepEqual(
    profileRuntimeMounts("gemini", { GOOGLE_APPLICATION_CREDENTIALS: "adc.json" }),
    [{ source: `${process.cwd()}/adc.json`, destination: `${process.cwd()}/adc.json` }],
  );
  assert.deepEqual(profileRuntimeMounts("gemini", {}), []);
});
