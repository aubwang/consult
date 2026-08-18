import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COPILOT_MIN_VERSION,
  copilotAgentVersionDiagnostic,
  profileHomeMounts,
  profileLaunchPolicy,
  profileModeArgs,
  profileRejectsResume,
  profileRuntimeMounts,
  profileSessionModeEnv,
  profileStripEnvKeys,
} from "./profile-launch-policy.mts";

test("profileLaunchPolicy exposes supported live launch policies only", () => {
  assert.ok(profileLaunchPolicy("claude"));
  assert.ok(profileLaunchPolicy("codex"));
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
});

test("profileSessionModeEnv pins the codex session preset to the Job mode", () => {
  assert.deepEqual(profileSessionModeEnv("codex", "read-only"), {
    INITIAL_AGENT_MODE: "read-only",
  });
  assert.deepEqual(profileSessionModeEnv("codex", "write"), {
    INITIAL_AGENT_MODE: "agent",
  });
});

test("profileSessionModeEnv stays inert for other profiles and unknown modes", () => {
  assert.deepEqual(profileSessionModeEnv("claude", "read-only"), {});
  assert.deepEqual(profileSessionModeEnv("opencode", "read-only"), {});
  assert.deepEqual(profileSessionModeEnv("copilot", "read-only"), {});
  assert.deepEqual(profileSessionModeEnv(undefined, "read-only"), {});
  assert.deepEqual(profileSessionModeEnv("codex", undefined), {});
  assert.deepEqual(profileSessionModeEnv("codex", "danger-full-access"), {});
});

test("profileModeArgs pins copilot tool denies to the Job mode", () => {
  assert.deepEqual(profileModeArgs("copilot", "read-only"), [
    "--no-auto-update",
    "--deny-tool=shell,write,url",
  ]);
  assert.deepEqual(profileModeArgs("copilot", "write"), [
    "--no-auto-update",
    "--deny-tool=shell,url",
  ]);
});

test("profileModeArgs denies the read-only set for unknown copilot modes", () => {
  assert.deepEqual(profileModeArgs("copilot", undefined), [
    "--no-auto-update",
    "--deny-tool=shell,write,url",
  ]);
  assert.deepEqual(profileModeArgs("copilot", "danger-full-access"), [
    "--no-auto-update",
    "--deny-tool=shell,write,url",
  ]);
});

test("profileModeArgs stays inert for other profiles", () => {
  assert.deepEqual(profileModeArgs("codex", "read-only"), []);
  assert.deepEqual(profileModeArgs("claude", "write"), []);
  assert.deepEqual(profileModeArgs("opencode", "read-only"), []);
  assert.deepEqual(profileModeArgs(undefined, "read-only"), []);
});

test("profileStripEnvKeys removes copilot allow-all and stays inert otherwise", () => {
  assert.deepEqual(profileStripEnvKeys("copilot"), ["COPILOT_ALLOW_ALL"]);
  assert.deepEqual(profileStripEnvKeys("codex"), []);
  assert.deepEqual(profileStripEnvKeys("claude"), []);
  assert.deepEqual(profileStripEnvKeys(undefined), []);
});

test("copilotAgentVersionDiagnostic enforces the floor from agent identity", () => {
  const copilotInfo = (version: unknown) => ({ agentInfo: { name: "Copilot", version } });

  assert.equal(copilotAgentVersionDiagnostic("copilot", copilotInfo(COPILOT_MIN_VERSION)), null);
  assert.equal(copilotAgentVersionDiagnostic("copilot", copilotInfo("1.0.80")), null);
  assert.match(
    copilotAgentVersionDiagnostic("copilot", copilotInfo("1.0.59"))!,
    /older than the supported/u,
  );
  assert.match(
    copilotAgentVersionDiagnostic("copilot", copilotInfo("0.0.421"))!,
    /older than the supported/u,
  );
  assert.match(copilotAgentVersionDiagnostic("copilot", copilotInfo(undefined))!, /unknown/u);
  assert.match(
    copilotAgentVersionDiagnostic("copilot", copilotInfo("1.0.79-8"))!,
    /older than the supported/u,
  );
  // A genuine Copilot behind an aliased or custom Profile is still enforced.
  assert.match(
    copilotAgentVersionDiagnostic("my-alias", copilotInfo("1.0.50"))!,
    /older than the supported/u,
  );
});

test("copilotAgentVersionDiagnostic fails closed when a copilot Profile hides identity", () => {
  assert.match(copilotAgentVersionDiagnostic("copilot", null)!, /cannot be verified/u);
  assert.match(copilotAgentVersionDiagnostic("copilot", {})!, /cannot be verified/u);
  assert.match(
    copilotAgentVersionDiagnostic("copilot", { agentInfo: { name: "other-agent" } })!,
    /cannot be verified/u,
  );

  assert.equal(copilotAgentVersionDiagnostic("codex", null), null);
  assert.equal(copilotAgentVersionDiagnostic("claude", {}), null);
  assert.equal(
    copilotAgentVersionDiagnostic(undefined, { agentInfo: { name: "other-agent" } }),
    null,
  );
});

test("profileRejectsResume refuses copilot session reopening only", () => {
  assert.equal(profileRejectsResume("copilot"), true);
  assert.equal(profileRejectsResume("codex"), false);
  assert.equal(profileRejectsResume("claude"), false);
  assert.equal(profileRejectsResume("opencode"), false);
  assert.equal(profileRejectsResume(undefined), false);
});
