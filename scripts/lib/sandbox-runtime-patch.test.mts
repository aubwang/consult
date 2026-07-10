import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

test("pinned Sandbox Runtime can disable host-derived default write paths", async () => {
  const jobWritePath = "/tmp/consult-sandbox-runtime-tripwire-job";
  const config = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ["/"],
      allowRead: [jobWritePath],
      allowWrite: [jobWritePath],
      denyWrite: [],
      includeDefaultWritePaths: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  } as SandboxRuntimeConfig & {
    filesystem: SandboxRuntimeConfig["filesystem"] & {
      includeDefaultWritePaths: false;
    };
  };

  SandboxManager.updateConfig(config);
  try {
    assert.deepEqual(SandboxManager.getFsWriteConfig(), {
      allowOnly: [jobWritePath],
      denyWithinAllow: [],
    });
    const allowOnly = SandboxManager.getFsWriteConfig().allowOnly ?? [];
    for (const hostDerivedPath of [
      "/tmp/claude",
      "/private/tmp/claude",
      path.join(os.homedir(), ".npm/_logs"),
      path.join(os.homedir(), ".claude/debug"),
    ]) {
      assert.equal(allowOnly.includes(hostDerivedPath), false, hostDerivedPath);
    }
  } finally {
    await SandboxManager.reset();
  }
});
