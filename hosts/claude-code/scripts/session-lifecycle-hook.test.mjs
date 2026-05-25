import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { brokerFilePath, brokersDir } from "../../../scripts/lib/broker-endpoint.mjs";
import { handleSessionLifecycleHook } from "./session-lifecycle-hook.mjs";

const hookScriptPath = fileURLToPath(new URL("./session-lifecycle-hook.mjs", import.meta.url));

test("SessionStart writes the Host session id into the env file without duplicates", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-"));
  try {
    const envFile = path.join(dir, "claude.env");
    await fsp.writeFile(
      envFile,
      "CONSULT_HOST_SESSION_ID=old-session\n",
      "utf8",
    );

    await handleSessionLifecycleHook("SessionStart", {
      env: {
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_SESSION_ID: "claude-1",
      },
      deps: {
        resolveWorkspaceRoot: async () => dir,
      },
    });

    const lines = (await fsp.readFile(envFile, "utf8")).trim().split("\n");
    assert.deepEqual(lines, ["CONSULT_HOST_SESSION_ID=claude-1", "CONSULT_HOST=claude-code"]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStart appends the Host session id without clobbering unrelated lines", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-"));
  try {
    const envFile = path.join(dir, "claude.env");
    await fsp.writeFile(envFile, "OTHER_VAR=foo\n", "utf8");

    await handleSessionLifecycleHook("SessionStart", {
      env: {
        CLAUDE_ENV_FILE: envFile,
        CLAUDE_SESSION_ID: "claude-2",
      },
      deps: {
        resolveWorkspaceRoot: async () => dir,
      },
    });

    const lines = (await fsp.readFile(envFile, "utf8")).trim().split("\n");
    assert.deepEqual(lines, [
      "OTHER_VAR=foo",
      "CONSULT_HOST=claude-code",
      "CONSULT_HOST_SESSION_ID=claude-2",
    ]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("SessionEnd tears down only broker files for this Host session", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-"));
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(dir, "data");
  try {
    const workspaceRoot = path.join(dir, "workspace");
    await fsp.mkdir(workspaceRoot);
    const brokerDir = brokersDir(workspaceRoot);
    await fsp.mkdir(brokerDir, { recursive: true });
    await writeBrokerState(workspaceRoot, {
      jobId: "job-codex",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "codex",
    });
    await writeBrokerState(workspaceRoot, {
      jobId: "job-opencode",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "opencode",
    });
    await writeBrokerState(workspaceRoot, {
      jobId: "job-other-session",
      host: "claude-code",
      hostSessionId: "claude-2",
      profile: "codex",
    });
    await writeBrokerState(workspaceRoot, {
      jobId: "job-terminal",
      host: "terminal",
      hostSessionId: "claude-1",
      profile: "codex",
    });
    const tornDown = [];

    await handleSessionLifecycleHook("SessionEnd", {
      env: {
        CLAUDE_SESSION_ID: "claude-1",
      },
      deps: {
        resolveWorkspaceRoot: async () => workspaceRoot,
        teardownBrokerSession: async (input) => {
          tornDown.push(input);
        },
      },
    });

    assert.deepEqual(
      tornDown.map(({ workspaceRoot, jobId, host, profile, hostSessionId }) => ({
        workspaceRoot,
        jobId,
        host,
        profile,
        hostSessionId,
      })),
      [
        {
          workspaceRoot,
          jobId: "job-codex",
          host: "claude-code",
          profile: "codex",
          hostSessionId: "claude-1",
        },
        {
          workspaceRoot,
          jobId: "job-opencode",
          host: "claude-code",
          profile: "opencode",
          hostSessionId: "claude-1",
        },
      ],
    );
  } finally {
    if (oldDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = oldDataDir;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("SessionEnd skips malformed broker state files", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-"));
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(dir, "data");
  try {
    const workspaceRoot = path.join(dir, "workspace");
    await fsp.mkdir(workspaceRoot);
    const brokerDir = brokersDir(workspaceRoot);
    await fsp.mkdir(brokerDir, { recursive: true });
    await fsp.writeFile(path.join(brokerDir, "broken.json"), "{not json\n", "utf8");
    await writeBrokerState(workspaceRoot, {
      jobId: "job-codex",
      host: "claude-code",
      hostSessionId: "claude-1",
      profile: "codex",
    });
    const tornDown = [];

    await handleSessionLifecycleHook("SessionEnd", {
      env: {
        CLAUDE_SESSION_ID: "claude-1",
      },
      deps: {
        resolveWorkspaceRoot: async () => workspaceRoot,
        teardownBrokerSession: async (input) => {
          tornDown.push(input.profile);
        },
      },
    });

    assert.deepEqual(tornDown, ["codex"]);
  } finally {
    if (oldDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = oldDataDir;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("SessionEnd surfaces broker state read errors", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-"));
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(dir, "data");
  try {
    const workspaceRoot = path.join(dir, "workspace");
    await fsp.mkdir(workspaceRoot);
    const brokerDir = brokersDir(workspaceRoot);
    await fsp.mkdir(path.join(brokerDir, "directory.json"), { recursive: true });

    await assert.rejects(
      handleSessionLifecycleHook("SessionEnd", {
        env: {
          CLAUDE_SESSION_ID: "claude-1",
        },
        deps: {
          resolveWorkspaceRoot: async () => workspaceRoot,
          teardownBrokerSession: async () => {
            throw new Error("teardown should not run");
          },
        },
      }),
      { code: "EISDIR" },
    );
  } finally {
    if (oldDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = oldDataDir;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function writeBrokerState(workspaceRoot, state) {
  await fsp.writeFile(
    brokerFilePath({ workspaceRoot, ...state }),
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
}

test("hook exits 0 when no workspace is detected", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-session-hook-no-git-"));
  try {
    const child = spawn(process.execPath, [hookScriptPath, "SessionStart"], {
      cwd: dir,
      env: {
        ...process.env,
        CLAUDE_ENV_FILE: path.join(dir, "claude.env"),
        CLAUDE_SESSION_ID: "claude-1",
      },
      stdio: "ignore",
    });
    const [code] = await once(child, "exit");

    assert.equal(code, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
