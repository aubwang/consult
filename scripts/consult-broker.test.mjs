import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { connectBroker } from "./lib/broker-client.mjs";
import { brokerFilePath, jobsDir } from "./lib/broker-endpoint.mjs";
import { DEFAULT_MAX_JSONL_MESSAGE_BYTES } from "./lib/jsonl-framing.mjs";
import { listenWithFallback } from "./lib/__fixtures__/socket-transport.mjs";
import { runDelegate } from "./lib/companion/delegate.mjs";
import { serveBroker } from "./consult-broker.mjs";

const fakeAgentPath = fileURLToPath(
  new URL("./lib/__fixtures__/fake-acp-agent.mjs", import.meta.url),
);

test("consult/ping returns broker health before the ACP agent is connected", async (t) => {
  const harness = await startBroker(t, { agentArgs: ["exit"] });
  const client = await connectBroker(harness.endpoint);

  try {
    const response = await client.request("consult/ping", {});
    assert.equal(response.ok, true);
    assert.equal(response.profile, "codex");
    assert.equal(response.capabilities, null);
  } finally {
    await client.close();
  }
});

test("consult/run accepts a job and streams update and finalized notifications", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-pre-resolve-update"],
  });
  const client = await connectBroker(harness.endpoint);
  const updatePromise = nextNotification(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    const response = await client.request("consult/run", {
      jobId: "job-1",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    });
    assert.deepEqual(response, { accepted: true, jobId: "job-1" });

    assert.deepEqual(await updatePromise, {
      jobId: "job-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before-response" },
      },
    });
    assert.deepEqual(await finalizedPromise, {
      jobId: "job-1",
      stopReason: "end_turn",
      sessionId: "sess-1",
    });
  } finally {
    await client.close();
  }
});

test("job-scoped broker shuts down and removes live state after finalization", async (t) => {
  const harness = await startBroker(t, {
    jobId: "job-scoped",
    finalizedShutdownGraceMs: 0,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  assert.deepEqual(
    await client.request("consult/run", {
      jobId: "job-scoped",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    }),
    { accepted: true, jobId: "job-scoped" },
  );
  assert.equal((await finalizedPromise).jobId, "job-scoped");
  await harness.broker.closed;

  assert.equal(await fileExists(harness.stateFile), false);
  assert.equal(await fileExists(harness.pidFile), false);
  assert.equal(await fileExists(harness.endpoint), false);
});

test("consult/run applies requested model and effort before prompting", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "controls"],
    captureMethods: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    assert.deepEqual(
      await client.request("consult/run", {
        jobId: "job-controls",
        prompt: "hello",
        profile: "codex",
        mode: "write",
        model: "gpt-test",
        effort: "high",
      }),
      { accepted: true, jobId: "job-controls" },
    );

    assert.deepEqual(await finalizedPromise, {
      jobId: "job-controls",
      stopReason: "end_turn",
      sessionId: "sess-1",
    });
    assert.deepEqual(
      (await readMethodLog(harness.methodLog)).map(({ method, params }) => ({ method, params })),
      [
        {
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: {
                readTextFile: true,
                writeTextFile: true,
              },
            },
          },
        },
        {
          method: "session/new",
          params: {
            cwd: harness.workspace,
            mcpServers: [],
          },
        },
        {
          method: "session/set_model",
          params: {
            sessionId: "sess-1",
            modelId: "gpt-test",
          },
        },
        {
          method: "session/set_config_option",
          params: {
            sessionId: "sess-1",
            configId: "thought-level",
            value: "high",
          },
        },
        {
          method: "session/prompt",
          params: {
            sessionId: "sess-1",
            prompt: [{ type: "text", text: "hello" }],
          },
        },
      ],
    );
  } finally {
    await client.close();
  }
});

test("consult/run can apply model through a model config option", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "controls-config-model"],
    captureMethods: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    assert.deepEqual(
      await client.request("consult/run", {
        jobId: "job-model-config",
        prompt: "hello",
        profile: "codex",
        mode: "write",
        model: "gpt-test",
      }),
      { accepted: true, jobId: "job-model-config" },
    );

    assert.deepEqual(await finalizedPromise, {
      jobId: "job-model-config",
      stopReason: "end_turn",
      sessionId: "sess-1",
    });
    const methods = await readMethodLog(harness.methodLog);
    assert.deepEqual(
      methods.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params),
      [
        {
          sessionId: "sess-1",
          configId: "model-option",
          value: "gpt-test",
        },
      ],
    );
    assert.equal(methods.some((entry) => entry.method === "session/set_model"), false);
  } finally {
    await client.close();
  }
});

test("consult/run fails clearly when requested effort is unsupported", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-pre-resolve-update"],
    captureMethods: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    assert.deepEqual(
      await client.request("consult/run", {
        jobId: "job-effort-unsupported",
        prompt: "hello",
        profile: "codex",
        mode: "write",
        effort: "high",
      }),
      { accepted: true, jobId: "job-effort-unsupported" },
    );

    const finalized = await finalizedPromise;
    assert.equal(finalized.jobId, "job-effort-unsupported");
    assert.equal(finalized.stopReason, "failed");
    assert.match(finalized.errorMessage, /EFFORT_UNSUPPORTED/);
    assert.equal(
      (await readMethodLog(harness.methodLog)).some((entry) => entry.method === "session/prompt"),
      false,
    );
  } finally {
    await client.close();
  }
});

test(
  "consult/run can launch the ACP agent through the bwrap sandbox",
  { skip: !fs.existsSync("/usr/bin/bwrap") },
  async (t) => {
    const repoRoot = path.resolve(path.dirname(fakeAgentPath), "../../..");
    const harness = await startBroker(t, {
      workspaceRoot: repoRoot,
      sandbox: "bwrap",
      agentArgs: ["sessions", "prompt-pre-resolve-update"],
    });
    const client = await connectBroker(harness.endpoint);
    const finalizedPromise = nextNotification(client, "consult/finalized");

    try {
      assert.deepEqual(
        await client.request("consult/run", {
          jobId: "job-sandbox",
          prompt: "hello",
          profile: "codex",
          mode: "read-only",
        }),
        { accepted: true, jobId: "job-sandbox" },
      );
      assert.deepEqual(await finalizedPromise, {
        jobId: "job-sandbox",
        stopReason: "end_turn",
        sessionId: "sess-1",
      });
    } finally {
      await client.close();
    }
  },
);

test("consult/run with resume calls ACP session/resume for the requested session", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-pre-resolve-update"],
    captureMethods: true,
    capturePrompts: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    assert.deepEqual(
      await client.request("consult/run", {
        jobId: "job-resume",
        prompt: "continue",
        profile: "codex",
        mode: "write",
        resume: "sess-prev",
      }),
      { accepted: true, jobId: "job-resume" },
    );

    assert.deepEqual(await finalizedPromise, {
      jobId: "job-resume",
      stopReason: "end_turn",
      sessionId: "sess-prev",
    });
    const methods = await readMethodLog(harness.methodLog);
    assert.equal(methods.some((entry) => entry.method === "session/new"), false);
    assert.equal(methods.some((entry) => entry.method === "session/load"), false);
    assert.deepEqual(
      methods.find((entry) => entry.method === "session/resume")?.params,
      { sessionId: "sess-prev", cwd: harness.workspace, mcpServers: [] },
    );
    assert.equal(
      JSON.parse((await fsp.readFile(harness.promptLog, "utf8")).trim()).sessionId,
      "sess-prev",
    );
  } finally {
    await client.close();
  }
});

test("consult/run with resume rejects agents without resume or load capability", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "capabilities-no-resume"],
    captureMethods: true,
  });
  const client = await connectBroker(harness.endpoint);

  try {
    await assert.rejects(
      client.request("consult/run", {
        jobId: "job-resume",
        prompt: "continue",
        profile: "codex",
        mode: "write",
        resume: "sess-prev",
      }),
      (error) => {
        assert.equal(error.code, "RESUME_UNSUPPORTED");
        assert.match(error.message, /does not support delegate --resume/);
        return true;
      },
    );
    const methods = await readMethodLog(harness.methodLog);
    assert.deepEqual(
      methods.map((entry) => entry.method),
      ["initialize"],
    );
  } finally {
    await client.close();
  }
});

test("consult/run with resume falls back to ACP session/load when resume is absent", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "capabilities-load-only"],
    captureMethods: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-load",
      prompt: "continue",
      profile: "codex",
      mode: "write",
      resume: "sess-prev",
    });

    assert.equal((await finalizedPromise).sessionId, "sess-prev");
    const methods = await readMethodLog(harness.methodLog);
    assert.equal(methods.some((entry) => entry.method === "session/resume"), false);
    assert.equal(methods.some((entry) => entry.method === "session/new"), false);
    assert.deepEqual(
      methods.find((entry) => entry.method === "session/load")?.params,
      { sessionId: "sess-prev", cwd: harness.workspace, mcpServers: [] },
    );
  } finally {
    await client.close();
  }
});

test("foreground delegate persists a complete finalized job record", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-updates"],
  });
  let delegateClient;
  const originalRename = fsp.rename.bind(fsp);
  let releaseBrokerReplace;
  let brokerReplaceFinished;
  let brokerReplaceDelayed = false;
  const brokerReplaceDelay = new Promise((resolve) => {
    releaseBrokerReplace = resolve;
  });
  const brokerReplaceComplete = new Promise((resolve) => {
    brokerReplaceFinished = resolve;
  });

  t.mock.method(fsp, "rename", async (fromPath, toPath) => {
    const isForegroundRecord = toPath === path.join(harness.jobsDir, "job-foreground.json");
    let pendingRecord = null;
    if (isForegroundRecord) {
      pendingRecord = JSON.parse(await fsp.readFile(fromPath, "utf8"));
    }
    const isBrokerReplace =
      pendingRecord?.jobId === "job-foreground" &&
      pendingRecord.stopReason === "end_turn" &&
      pendingRecord.kind === undefined;
    if (isBrokerReplace) {
      brokerReplaceDelayed = true;
      await brokerReplaceDelay;
    }

    const result = await originalRename(fromPath, toPath);
    if (isBrokerReplace) {
      brokerReplaceFinished();
    }
    return result;
  });

  const result = await runDelegate({
    args: { positional: ["persist", "metadata"], flags: { "read-only": true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => harness.workspace,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        delegateClient = await connectBroker(harness.endpoint);
        return { client: delegateClient };
      },
      now: fixedClock(["2026-05-14T10:00:00.000Z"]),
      generateJobId: () => "job-foreground",
      stdoutWrite: () => {},
      stderrWrite: () => {},
    },
  });
  await delegateClient?.close();
  if (brokerReplaceDelayed) {
    releaseBrokerReplace();
    await brokerReplaceComplete;
  }

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /firstsecond/);
  const record = await waitForJobRecord(harness, "job-foreground", (value) => {
    return value.status === "completed";
  });
  assert.equal(record.kind, "delegate");
  assert.equal(record.host, "claude-code");
  assert.equal(record.profile, "codex");
  assert.equal(record.mode, "read-only");
  assert.equal(record.prompt, "persist metadata");
  assert.equal(record.hostSessionId, "claude-1");
  assert.equal(record.submittedAt, "2026-05-14T10:00:00.000Z");
  assert.equal(record.chainId, "job-foreground");
  assert.equal(record.parentJobId, null);
  assert.equal(record.delegationDepth, 0);
  assert.equal(record.finalText, "firstsecond");
  assert.equal(record.jobId, "job-foreground");
  assert.equal(record.status, "completed");
  assert.equal(record.stopReason, "end_turn");
  assert.equal(record.sessionId, "sess-1");
  assert.match(record.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(record.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Date.parse(record.completedAt) >= Date.parse(record.startedAt));
});

test("foreground delegate captures a response chunk delayed after prompt completion", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-delayed-post-resolve-update"],
  });
  let delegateClient;

  const result = await runDelegate({
    args: { positional: ["delayed", "response"], flags: { "read-only": true } },
    env: { CONSULT_HOST: "claude-code", CONSULT_HOST_SESSION_ID: "claude-1" },
    deps: {
      resolveWorkspaceRoot: async () => harness.workspace,
      loadOverride: async () => null,
      loadProfiles: async () => profilesFixture(),
      ensureBrokerSession: async () => {
        delegateClient = await connectBroker(harness.endpoint);
        return { client: delegateClient };
      },
      now: fixedClock(["2026-05-14T10:00:00.000Z"]),
      generateJobId: () => "job-delayed-response",
      stdoutWrite: () => {},
      stderrWrite: () => {},
    },
  });
  await delegateClient?.close();

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /delayed-response/);
  const record = await waitForJobRecord(harness, "job-delayed-response", (value) => {
    return value.status === "completed";
  });
  assert.equal(record.finalText, "delayed-response");
});

test("consult/run allows an in-workspace edit permission request in write mode", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-permission-edit"],
    captureClientCalls: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "edit",
      profile: "codex",
      mode: "write",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    assert.deepEqual(await readClientObservations(harness.clientLog), [
      {
        method: "session/request_permission",
        message: {
          jsonrpc: "2.0",
          id: "client-1",
          result: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

test("consult/run denies an edit permission request in read-only mode", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-permission-edit"],
    captureClientCalls: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "edit",
      profile: "codex",
      mode: "read-only",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    const observations = await readClientObservations(harness.clientLog);
    assert.equal(observations[0].message.result.outcome.outcome, "selected");
    assert.equal(observations[0].message.result.outcome.optionId, "reject");
    assert.match(observations[0].message.result._meta.reason, /read-only/);
  } finally {
    await client.close();
  }
});

test("consult/run denies an edit permission request outside the workspace", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-permission-edit"],
    captureClientCalls: true,
    fakeTargetPath: "/etc/hostname",
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "edit",
      profile: "codex",
      mode: "write",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    const observations = await readClientObservations(harness.clientLog);
    assert.equal(observations[0].message.result.outcome.optionId, "reject");
    assert.match(observations[0].message.result._meta.reason, /outside workspace/);
  } finally {
    await client.close();
  }
});

test("consult/run allows fs/read_text_file inside the workspace", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-fs-read"],
    captureClientCalls: true,
    fakeTargetRelative: "note.txt",
  });
  await fsp.writeFile(path.join(harness.workspace, "note.txt"), "hello from workspace\n");
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "read",
      profile: "codex",
      mode: "write",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    assert.deepEqual(await readClientObservations(harness.clientLog), [
      {
        method: "fs/read_text_file",
        message: {
          jsonrpc: "2.0",
          id: "client-1",
          result: {
            content: "hello from workspace\n",
          },
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

test("consult/run denies fs/write_text_file in read-only mode", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-fs-write"],
    captureClientCalls: true,
    fakeTargetRelative: "note.txt",
  });
  const filePath = path.join(harness.workspace, "note.txt");
  await fsp.writeFile(filePath, "original\n");
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write",
      profile: "codex",
      mode: "read-only",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    const observations = await readClientObservations(harness.clientLog);
    assert.equal(observations[0].method, "fs/write_text_file");
    assert.equal(observations[0].message.error.code, -32602);
    assert.match(observations[0].message.error.message, /read-only/);
    assert.equal(await fsp.readFile(filePath, "utf8"), "original\n");
  } finally {
    await client.close();
  }
});

test("consult/run fails read-only auto-approved edit updates", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-auto-approved-edit"],
    captureCancels: true,
  });
  const client = await connectBroker(harness.endpoint);
  const nextClient = await connectBroker(harness.endpoint);
  const updates = collectNotifications(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");
  const nextFinalized = nextNotification(nextClient, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write without asking",
      profile: "codex",
      mode: "read-only",
    });

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "failed");
    assert.match(finalized.errorMessage, /policy violation: auto-approved edit/);
    assert.equal(updates.length, 0);

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "failed";
    });
    assert.equal(record.mode, "read-only");
    assert.equal(record.errorMessage, finalized.errorMessage);
    assert.equal(record.sessionId, "sess-1");
    await waitForCancelCount(harness.cancelLog, 1);

    assert.deepEqual(
      await nextClient.request("consult/run", {
        jobId: "job-2",
        prompt: "after policy violation",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-2" },
    );
    assert.equal((await nextFinalized).jobId, "job-2");
  } finally {
    await client.close();
    await nextClient.close();
  }
});

test("consult/run allows in-workspace auto-approved edit updates in write mode", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-auto-approved-edit"],
  });
  const client = await connectBroker(harness.endpoint);
  const updates = collectNotifications(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write inside without asking",
      profile: "codex",
      mode: "write",
    });

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "end_turn");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.rawInput.path, "inside.txt");

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "completed";
    });
    assert.equal(record.mode, "write");
    assert.equal(record.stopReason, "end_turn");
  } finally {
    await client.close();
  }
});

test("consult/run fails write-mode auto-approved edit updates outside the workspace", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-auto-approved-edit-outside-workspace"],
    fakeTargetPath: "/etc/hostname",
  });
  const client = await connectBroker(harness.endpoint);
  const nextClient = await connectBroker(harness.endpoint);
  const updates = collectNotifications(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");
  const nextFinalized = nextNotification(nextClient, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write outside without asking",
      profile: "codex",
      mode: "write",
    });

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "failed");
    assert.match(finalized.errorMessage, /auto-approved edit outside workspace/);
    assert.equal(updates.length, 0);

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "failed";
    });
    assert.equal(record.mode, "write");
    assert.equal(record.errorMessage, finalized.errorMessage);
    assert.equal(record.sessionId, "sess-1");

    assert.deepEqual(
      await nextClient.request("consult/run", {
        jobId: "job-2",
        prompt: "after policy violation",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-2" },
    );
    const followup = await nextFinalized;
    assert.equal(followup.jobId, "job-2");
    assert.equal(followup.stopReason, "end_turn");
  } finally {
    await client.close();
    await nextClient.close();
  }
});

test("consult/run fails write-mode claude-style edit updates outside the workspace", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-claude-style-edit-outside"],
  });
  const client = await connectBroker(harness.endpoint);
  const updates = collectNotifications(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write outside with claude shape",
      profile: "codex",
      mode: "write",
    });

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "failed");
    assert.match(finalized.errorMessage, /auto-approved edit outside workspace/);
    assert.equal(updates.length, 0);

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "failed";
    });
    assert.equal(record.mode, "write");
    assert.equal(record.errorMessage, finalized.errorMessage);
    assert.equal(record.sessionId, "sess-1");
  } finally {
    await client.close();
  }
});

test("consult/run allows in-workspace claude-style edit updates in write mode", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-claude-style-edit-inside"],
    fakeTargetRelative: "inside.txt",
  });
  const client = await connectBroker(harness.endpoint);
  const updates = collectNotifications(client, "consult/update");
  const finalizedPromise = nextNotification(client, "consult/finalized");
  const insidePath = path.join(harness.workspace, "inside.txt");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "write inside with claude shape",
      profile: "codex",
      mode: "write",
    });

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "end_turn");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.locations[0].path, insidePath);
    assert.equal(updates[0].update.rawInput.file_path, insidePath);

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "completed";
    });
    assert.equal(record.mode, "write");
    assert.equal(record.stopReason, "end_turn");
  } finally {
    await client.close();
  }
});

test("consult/run denies fs/read_text_file through a symlink outside the workspace", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-fs-read"],
    captureClientCalls: true,
    fakeTargetRelative: "host-link",
  });
  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "consult-outside-"));
  t.after(async () => {
    await fsp.rm(outsideRoot, { recursive: true, force: true });
  });
  const outsidePath = path.join(outsideRoot, "secret.txt");
  await fsp.writeFile(outsidePath, "secret\n", "utf8");
  await fsp.symlink(outsidePath, path.join(harness.workspace, "host-link"));
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "read",
      profile: "codex",
      mode: "write",
    });

    assert.equal((await finalizedPromise).stopReason, "end_turn");
    const observations = await readClientObservations(harness.clientLog);
    assert.equal(observations[0].method, "fs/read_text_file");
    assert.equal(observations[0].message.error.code, -32602);
    assert.match(observations[0].message.error.message, /outside workspace/);
  } finally {
    await client.close();
  }
});

test("consult/run rejects a second in-flight job with BROKER_BUSY", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-slow"],
  });
  const firstClient = await connectBroker(harness.endpoint);
  const secondClient = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(firstClient, "consult/finalized");

  try {
    assert.deepEqual(
      await firstClient.request("consult/run", {
        jobId: "job-1",
        prompt: "slow",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-1" },
    );

    await assert.rejects(
      secondClient.request("consult/run", {
        jobId: "job-2",
        prompt: "second",
        profile: "codex",
        mode: "write",
      }),
      (error) => {
        assert.equal(error.code, "BROKER_BUSY");
        return true;
      },
    );
    assert.equal((await finalizedPromise).jobId, "job-1");
  } finally {
    await firstClient.close();
    await secondClient.close();
  }
});

test("consult/ping bypasses BROKER_BUSY while a prompt turn is in flight", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-slow"],
  });
  const runClient = await connectBroker(harness.endpoint);
  const pingClient = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(runClient, "consult/finalized");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "slow",
      profile: "codex",
      mode: "write",
    });

    const response = await pingClient.request("consult/ping", {}, { timeoutMs: 100 });
    assert.equal(response.ok, true);
    assert.equal(response.profile, "codex");
    assert.equal((await finalizedPromise).jobId, "job-1");
  } finally {
    await runClient.close();
    await pingClient.close();
  }
});

test("broker/shutdown closes sockets and removes broker state files", async (t) => {
  const harness = await startBroker(t);
  const firstClient = await connectBroker(harness.endpoint);
  const secondClient = await connectBroker(harness.endpoint);

  assert.equal(fs.existsSync(harness.stateFile), true);
  assert.equal(fs.existsSync(harness.pidFile), true);

  const response = await firstClient.request("broker/shutdown", {});

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(await harness.broker.closed, { code: 0 });
  await waitFor(() => firstClient.closed && secondClient.closed);
  assert.equal(fs.existsSync(harness.stateFile), false);
  assert.equal(fs.existsSync(harness.pidFile), false);
});

test("idle broker shuts down after the idle timeout", async (t) => {
  const harness = await startBroker(t, { idleTimeoutMs: 20 });

  assert.equal(fs.existsSync(harness.stateFile), true);
  assert.deepEqual(await withTimeout(harness.broker.closed, 500), { code: 0 });
  assert.equal(fs.existsSync(harness.stateFile), false);
  assert.equal(fs.existsSync(harness.pidFile), false);
});

test("connected clients prevent idle broker shutdown until they disconnect", async (t) => {
  const harness = await startBroker(t, { idleTimeoutMs: 30 });
  const client = await connectBroker(harness.endpoint);

  await assertNotClosedWithin(harness.broker.closed, 80);
  await client.close();
  assert.deepEqual(await withTimeout(harness.broker.closed, 500), { code: 0 });
});

test("running jobs prevent idle broker shutdown after originator disconnect", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-slow"],
    cancelAckTimeoutMs: 500,
    idleTimeoutMs: 20,
  });
  const client = await connectBroker(harness.endpoint);

  await client.request("consult/run", {
    jobId: "job-1",
    prompt: "slow",
    profile: "codex",
    mode: "write",
  });
  await client.close();

  await assertNotClosedWithin(harness.broker.closed, 80);
  assert.deepEqual(await withTimeout(harness.broker.closed, 500), { code: 0 });
});

test("unknown RPC methods return JSON-RPC method not found", async (t) => {
  const harness = await startBroker(t);
  const client = await connectBroker(harness.endpoint);

  try {
    await assert.rejects(client.request("consult/nope", {}), (error) => {
      assert.equal(error.code, -32601);
      assert.equal(error.message, "method not found: consult/nope");
      return true;
    });
  } finally {
    await client.close();
  }
});

test("malformed socket messages return a parse error without crashing the broker", async (t) => {
  const harness = await startBroker(t);
  const socket = net.createConnection(harness.endpoint);
  await once(socket, "connect");

  try {
    socket.write("{\n");
    assert.deepEqual(JSON.parse(await readSocketLine(socket)), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    await once(socket, "close");

    const client = await connectBroker(harness.endpoint);
    try {
      assert.equal((await client.request("consult/ping", {})).ok, true);
    } finally {
      await client.close();
    }
  } finally {
    socket.destroy();
  }
});

test("oversized socket messages return an error without unbounded buffering", async (t) => {
  const harness = await startBroker(t);
  const socket = net.createConnection(harness.endpoint);
  await once(socket, "connect");

  try {
    socket.write("x".repeat(DEFAULT_MAX_JSONL_MESSAGE_BYTES + 1));
    const response = JSON.parse(await readSocketLine(socket));
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, null);
    assert.deepEqual(response.error, {
      code: "MESSAGE_TOO_LARGE",
      message: `JSON-RPC message exceeds ${DEFAULT_MAX_JSONL_MESSAGE_BYTES} bytes`,
    });
    await once(socket, "close");

    const client = await connectBroker(harness.endpoint);
    try {
      assert.equal((await client.request("consult/ping", {})).ok, true);
    } finally {
      await client.close();
    }
  } finally {
    socket.destroy();
  }
});

test("invalid RPC params return invalid params without crashing the broker", async (t) => {
  const harness = await startBroker(t);
  const socket = net.createConnection(harness.endpoint);
  await once(socket, "connect");

  try {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "consult/cancel" })}\n`);
    assert.deepEqual(JSON.parse(await readSocketLine(socket)), {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "invalid params" },
    });

    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "consult/attach", params: null })}\n`,
    );
    assert.deepEqual(JSON.parse(await readSocketLine(socket)), {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "invalid params" },
    });

    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "consult/run", params: [] })}\n`,
    );
    assert.deepEqual(JSON.parse(await readSocketLine(socket)), {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "invalid params" },
    });

    const client = await connectBroker(harness.endpoint);
    try {
      assert.equal((await client.request("consult/ping", {})).ok, true);
    } finally {
      await client.close();
    }
  } finally {
    socket.destroy();
  }
});

test("consult/run with the same running jobId and payload reattaches without a duplicate prompt", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-reattach"],
    capturePrompts: true,
  });
  const firstClient = await connectBroker(harness.endpoint);
  const secondClient = await connectBroker(harness.endpoint);
  const firstUpdates = collectNotifications(firstClient, "consult/update");
  const secondUpdates = collectNotifications(secondClient, "consult/update");
  const firstFinalized = nextNotification(firstClient, "consult/finalized");
  const secondFinalized = nextNotification(secondClient, "consult/finalized");

  try {
    assert.deepEqual(
      await firstClient.request("consult/run", {
        jobId: "job-1",
        prompt: "hello",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-1" },
    );
    await waitFor(() => firstUpdates.length === 1);

    assert.deepEqual(
      await secondClient.request("consult/run", {
        jobId: "job-1",
        prompt: "hello",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-1" },
    );

    await waitFor(() => secondUpdates.length === 2);
    assert.deepEqual(
      secondUpdates.map((notification) => notification.update.content.text),
      ["buffered-1", "live-1"],
    );
    assert.deepEqual(await secondFinalized, await firstFinalized);
    assert.equal(await promptCount(harness.promptLog), 1);
  } finally {
    await firstClient.close();
    await secondClient.close();
  }
});

test("consult/run with the same running jobId and a different payload rejects with JOB_CONFLICT", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-slow"],
    capturePrompts: true,
  });
  const firstClient = await connectBroker(harness.endpoint);
  const secondClient = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(firstClient, "consult/finalized");

  try {
    assert.deepEqual(
      await firstClient.request("consult/run", {
        jobId: "job-1",
        prompt: "original",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-1" },
    );

    await assert.rejects(
      secondClient.request("consult/run", {
        jobId: "job-1",
        prompt: "changed",
        profile: "codex",
        mode: "write",
      }),
      (error) => {
        assert.equal(error.code, "JOB_CONFLICT");
        return true;
      },
    );

    assert.equal((await finalizedPromise).jobId, "job-1");
    assert.equal(await promptCount(harness.promptLog), 1);
  } finally {
    await firstClient.close();
    await secondClient.close();
  }
});

test("consult/run with a finalized jobId rejects with JOB_FINALIZED", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-pre-resolve-update"],
    capturePrompts: true,
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    });
    assert.equal((await finalizedPromise).jobId, "job-1");

    await assert.rejects(
      client.request("consult/run", {
        jobId: "job-1",
        prompt: "hello",
        profile: "codex",
        mode: "write",
      }),
      (error) => {
        assert.equal(error.code, "JOB_FINALIZED");
        return true;
      },
    );
    assert.equal(await promptCount(harness.promptLog), 1);
  } finally {
    await client.close();
  }
});

test("consult/attach to an unknown jobId rejects with UNKNOWN_JOB", async (t) => {
  const harness = await startBroker(t);
  const client = await connectBroker(harness.endpoint);

  try {
    await assert.rejects(
      client.request("consult/attach", { jobId: "missing" }),
      (error) => {
        assert.equal(error.code, "UNKNOWN_JOB");
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("consult/attach to a running job receives buffered and live updates while bypassing BROKER_BUSY", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-reattach-busy"],
    capturePrompts: true,
  });
  const runClient = await connectBroker(harness.endpoint);
  const attachClient = await connectBroker(harness.endpoint);
  const busyClient = await connectBroker(harness.endpoint);
  const runUpdates = collectNotifications(runClient, "consult/update");
  const attachUpdates = collectNotifications(attachClient, "consult/update");
  const runFinalized = nextNotification(runClient, "consult/finalized");
  const attachFinalized = nextNotification(attachClient, "consult/finalized");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    });
    await waitFor(() => runUpdates.length === 1);

    assert.deepEqual(await attachClient.request("consult/attach", { jobId: "job-1" }), {
      attached: true,
      jobId: "job-1",
    });

    await assert.rejects(
      busyClient.request("consult/run", {
        jobId: "job-2",
        prompt: "other",
        profile: "codex",
        mode: "write",
      }),
      (error) => {
        assert.equal(error.code, "BROKER_BUSY");
        return true;
      },
    );

    await waitFor(() => attachUpdates.length === 2);
    assert.deepEqual(
      attachUpdates.map((notification) => notification.update.content.text),
      ["buffered-1", "live-1"],
    );
    assert.deepEqual(await attachFinalized, await runFinalized);
    assert.equal(await promptCount(harness.promptLog), 1);
  } finally {
    await runClient.close();
    await attachClient.close();
    await busyClient.close();
  }
});

test("consult/attach reports dropped buffered updates after overflow", async (t) => {
  const updateCount = 550;
  const harness = await startBroker(t, {
    agentArgs: ["sessions", `prompt-many-updates-${updateCount}`],
  });
  const runClient = await connectBroker(harness.endpoint);
  const attachClient = await connectBroker(harness.endpoint);
  const runUpdates = collectNotifications(runClient, "consult/update");
  const attachUpdates = collectNotifications(attachClient, "consult/update");
  const attachFinalized = nextNotification(attachClient, "consult/finalized");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "many",
      profile: "codex",
      mode: "write",
    });
    await waitFor(() => runUpdates.length === updateCount);

    assert.deepEqual(await attachClient.request("consult/attach", { jobId: "job-1" }), {
      attached: true,
      jobId: "job-1",
    });

    await waitFor(() => attachUpdates.length === 501);
    assert.equal(attachUpdates.length, 501);
    assert.deepEqual(attachUpdates[0].update, {
      sessionUpdate: "consult_update_gap",
      droppedUpdateCount: updateCount - 500,
    });
    assert.equal(attachUpdates[1].update.content.text, `update-${updateCount - 500}`);
    assert.equal(attachUpdates.at(-1).update.content.text, `update-${updateCount - 1}`);
    assert.equal((await attachFinalized).jobId, "job-1");
  } finally {
    await runClient.close();
    await attachClient.close();
  }
});

test("consult/cancel cancels an in-flight job from a second socket and frees BROKER_BUSY", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-cancel-ack"],
  });
  const runClient = await connectBroker(harness.endpoint);
  const cancelClient = await connectBroker(harness.endpoint);
  const nextClient = await connectBroker(harness.endpoint);
  const updates = collectNotifications(runClient, "consult/update");
  const finalizedPromise = nextNotification(runClient, "consult/finalized");
  const nextFinalized = nextNotification(nextClient, "consult/finalized");

  try {
    assert.deepEqual(
      await runClient.request("consult/run", {
        jobId: "job-1",
        prompt: "slow",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-1" },
    );
    await waitFor(() => updates.length === 1);

    assert.deepEqual(
      await cancelClient.request("consult/cancel", { jobId: "job-1" }, { timeoutMs: 50 }),
      { ok: true },
    );

    assert.deepEqual(await finalizedPromise, {
      jobId: "job-1",
      stopReason: "cancelled",
      sessionId: "sess-1",
    });

    assert.deepEqual(
      await nextClient.request("consult/run", {
        jobId: "job-2",
        prompt: "next",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-2" },
    );
    assert.equal((await nextFinalized).jobId, "job-2");
  } finally {
    await runClient.close();
    await cancelClient.close();
    await nextClient.close();
  }
});

test("consult/cancel to an unknown jobId rejects with UNKNOWN_JOB", async (t) => {
  const harness = await startBroker(t);
  const client = await connectBroker(harness.endpoint);

  try {
    await assert.rejects(
      client.request("consult/cancel", { jobId: "missing" }),
      (error) => {
        assert.equal(error.code, "UNKNOWN_JOB");
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("consult/cancel on a finalized job is idempotent", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-pre-resolve-update"],
  });
  const client = await connectBroker(harness.endpoint);
  const finalizedPromise = nextNotification(client, "consult/finalized");

  try {
    await client.request("consult/run", {
      jobId: "job-1",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    });
    assert.equal((await finalizedPromise).jobId, "job-1");

    assert.deepEqual(await client.request("consult/cancel", { jobId: "job-1" }), {
      ok: true,
      alreadyFinalized: true,
    });
  } finally {
    await client.close();
  }
});

test("consult/cancel on a finalized parent cascades to an active child", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-first-resolve-second-cancel-ack"],
    captureCancels: true,
  });
  const parentClient = await connectBroker(harness.endpoint);
  const childClient = await connectBroker(harness.endpoint);
  const cancelClient = await connectBroker(harness.endpoint);
  const parentFinalized = nextNotification(parentClient, "consult/finalized");
  const childUpdates = collectNotifications(childClient, "consult/update");
  const childFinalized = nextNotification(childClient, "consult/finalized");

  try {
    await parentClient.request("consult/run", {
      jobId: "job-parent",
      prompt: "parent",
      profile: "codex",
      mode: "write",
      chainId: "job-parent",
      parentJobId: null,
      delegationDepth: 0,
    });
    assert.equal((await parentFinalized).jobId, "job-parent");

    await childClient.request("consult/run", {
      jobId: "job-child",
      prompt: "child",
      profile: "codex",
      mode: "write",
      chainId: "job-parent",
      parentJobId: "job-parent",
      delegationDepth: 1,
    });
    await waitFor(() => childUpdates.length === 1);

    assert.deepEqual(await cancelClient.request("consult/cancel", { jobId: "job-parent" }), {
      ok: true,
      alreadyFinalized: true,
      cascadedJobIds: ["job-child"],
    });
    assert.deepEqual(await childFinalized, {
      jobId: "job-child",
      stopReason: "cancelled",
      sessionId: "sess-1",
    });
    await waitForCancelCount(harness.cancelLog, 1);
  } finally {
    await parentClient.close();
    await childClient.close();
    await cancelClient.close();
  }
});

test("originator disconnect mid-prompt cancels the job when the agent acknowledges", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-cancel-ack"],
    captureCancels: true,
  });
  const runClient = await connectBroker(harness.endpoint);
  const nextClient = await connectBroker(harness.endpoint);
  const updates = collectNotifications(runClient, "consult/update");
  const nextFinalized = nextNotification(nextClient, "consult/finalized");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "slow",
      profile: "codex",
      mode: "write",
    });
    await waitFor(() => updates.length === 1);

    await runClient.close();

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "cancelled";
    });
    assert.equal(record.stopReason, "cancelled");
    assert.equal(record.sessionId, "sess-1");
    assert.equal(await cancelCount(harness.cancelLog), 1);
    assert.equal(harness.broker.tainted, false);

    assert.deepEqual(
      await nextClient.request("consult/run", {
        jobId: "job-2",
        prompt: "next",
        profile: "codex",
        mode: "write",
      }),
      { accepted: true, jobId: "job-2" },
    );
    assert.equal((await nextFinalized).jobId, "job-2");
  } finally {
    await nextClient.close();
  }
});

test("originator disconnect mid-prompt taints the broker when the agent does not acknowledge cancel", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-cancel-no-ack"],
    captureCancels: true,
    cancelAckTimeoutMs: 200,
  });
  const runClient = await connectBroker(harness.endpoint);
  const workClient = await connectBroker(harness.endpoint);
  const pingClient = await connectBroker(harness.endpoint);
  const updates = collectNotifications(runClient, "consult/update");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "slow",
      profile: "codex",
      mode: "write",
    });
    await waitFor(() => updates.length === 1);

    await runClient.close();

    const record = await waitForJobRecord(harness, "job-1", (value) => {
      return value.status === "failed";
    });
    assert.equal(record.errorMessage, "agent did not acknowledge cancel");
    assert.equal(await cancelCount(harness.cancelLog), 1);
    assert.equal(harness.broker.tainted, true);

    await assert.rejects(
      workClient.request("consult/run", {
        jobId: "job-2",
        prompt: "next",
        profile: "codex",
        mode: "write",
      }),
      (error) => {
        assert.equal(error.code, "BROKER_TAINTED");
        return true;
      },
    );

    const ping = await pingClient.request("consult/ping", {}, { timeoutMs: 100 });
    assert.equal(ping.ok, true);
  } finally {
    await workClient.close();
    await pingClient.close();
  }
});

test("non-originator subscriber disconnect mid-prompt does not cancel the job", async (t) => {
  const harness = await startBroker(t, {
    agentArgs: ["sessions", "prompt-reattach-busy"],
    captureCancels: true,
  });
  const runClient = await connectBroker(harness.endpoint);
  const attachClient = await connectBroker(harness.endpoint);
  const runUpdates = collectNotifications(runClient, "consult/update");
  const attachUpdates = collectNotifications(attachClient, "consult/update");
  const finalizedPromise = nextNotification(runClient, "consult/finalized");

  try {
    await runClient.request("consult/run", {
      jobId: "job-1",
      prompt: "hello",
      profile: "codex",
      mode: "write",
    });
    await waitFor(() => runUpdates.length === 1);

    assert.deepEqual(await attachClient.request("consult/attach", { jobId: "job-1" }), {
      attached: true,
      jobId: "job-1",
    });
    await waitFor(() => attachUpdates.length === 1);
    await attachClient.close();

    const finalized = await finalizedPromise;
    assert.equal(finalized.stopReason, "end_turn");
    assert.deepEqual(
      runUpdates.map((notification) => notification.update.content.text),
      ["buffered-1", "live-1"],
    );
    assert.equal(await cancelCount(harness.cancelLog), 0);
    assert.equal(harness.broker.tainted, false);
  } finally {
    await runClient.close();
  }
});

async function startBroker(
  t,
  {
    agentArgs = ["sessions"],
    capturePrompts = false,
    captureCancels = false,
    captureClientCalls = false,
    captureMethods = false,
    fakeTargetPath,
    fakeTargetRelative,
    cancelAckTimeoutMs,
    finalizedShutdownGraceMs,
    idleTimeoutMs,
    jobId,
    workspaceRoot,
    sandbox,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-broker-"));
  const workspace = workspaceRoot ?? path.join(dir, "workspace");
  const dataDir = path.join(dir, "data");
  const endpoint = path.join(dir, "broker.sock");
  const brokerSessionId = `claude-1-${path.basename(dir)}`;
  const host = "claude-code";
  const pidFile = path.join(dir, "broker.pid");
  const promptLog = path.join(dir, "prompts.ndjson");
  const cancelLog = path.join(dir, "cancels.ndjson");
  const clientLog = path.join(dir, "client.ndjson");
  const methodLog = path.join(dir, "methods.ndjson");
  const oldDataDir = process.env.CONSULT_DATA_DIR;
  let broker;

  if (!workspaceRoot) {
    await fsp.mkdir(workspace);
  }
  process.env.CONSULT_DATA_DIR = dataDir;
  t.after(async () => {
    await broker?.shutdown();
    if (oldDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = oldDataDir;
    }
    await rmTempDir(dir);
  });

  broker = await serveBroker(
    {
      endpoint,
      cwd: workspace,
      profile: "codex",
      binary: process.execPath,
      args: [fakeAgentPath, ...agentArgs],
      env: {
        ...(capturePrompts ? { CONSULT_FAKE_AGENT_PROMPT_LOG: promptLog } : {}),
        ...(captureCancels ? { CONSULT_FAKE_AGENT_CANCEL_LOG: cancelLog } : {}),
        ...(captureClientCalls ? { CONSULT_FAKE_AGENT_CLIENT_LOG: clientLog } : {}),
        ...(captureMethods ? { CONSULT_FAKE_AGENT_METHOD_LOG: methodLog } : {}),
        ...(fakeTargetPath || fakeTargetRelative
          ? {
              CONSULT_FAKE_AGENT_TARGET_PATH:
                fakeTargetPath ?? path.join(workspace, fakeTargetRelative),
            }
          : {}),
      },
      pidFile,
      jobId,
      host,
      hostSessionId: brokerSessionId,
      cancelAckTimeoutMs,
      finalizedShutdownGraceMs,
      idleTimeoutMs,
      sandbox,
    },
    {
      listen: (server, socketPath) => listenWithFallback(t, server, socketPath),
    },
  );

  return {
    broker,
    endpoint,
    workspace,
    pidFile,
    promptLog,
    cancelLog,
    clientLog,
    methodLog,
    jobsDir: jobsDir(workspace),
    stateFile: brokerFilePath({
      workspaceRoot: workspace,
      jobId,
      host,
      profile: "codex",
      hostSessionId: brokerSessionId,
    }),
  };
}

async function rmTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function profilesFixture() {
  return {
    schemaVersion: 1,
    default: "codex",
    profiles: {
      codex: {
        registryId: "codex",
        binary: fakeAgentPath,
        args: [],
        env: {},
        installedAt: "2026-05-14T09:00:00.000Z",
      },
    },
  };
}

function fixedClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function readClientObservations(clientLog) {
  const content = await fsp.readFile(clientLog, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readMethodLog(methodLog) {
  const content = await fsp.readFile(methodLog, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function nextNotification(client, method) {
  return new Promise((resolve) => {
    client.on(method, resolve);
  });
}

function readSocketLine(socket) {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", function onData(chunk) {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      socket.off("data", onData);
      resolve(buffer.slice(0, newlineIndex));
    });
  });
}

function collectNotifications(client, method) {
  const notifications = [];
  client.on(method, (params) => notifications.push(params));
  return notifications;
}

async function promptCount(promptLog) {
  const content = await fsp.readFile(promptLog, "utf8");
  return content.trim().split("\n").filter(Boolean).length;
}

async function cancelCount(cancelLog) {
  let content;
  try {
    content = await fsp.readFile(cancelLog, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  return content.trim().split("\n").filter(Boolean).length;
}

async function waitForCancelCount(cancelLog, expected) {
  const deadline = Date.now() + 500;
  let count = 0;
  while (Date.now() < deadline) {
    count = await cancelCount(cancelLog);
    if (count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(count, expected);
}

async function readJobRecord(harness, jobId) {
  try {
    return JSON.parse(await fsp.readFile(path.join(harness.jobsDir, `${jobId}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForJobRecord(harness, jobId, predicate) {
  const deadline = Date.now() + 500;
  let record = null;
  while (Date.now() < deadline) {
    record = await readJobRecord(harness, jobId);
    if (record && predicate(record)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(record, `expected job record for ${jobId}`);
  assert.equal(predicate(record), true);
  return record;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for broker close")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertNotClosedWithin(promise, timeoutMs) {
  let timeout;
  try {
    const result = await Promise.race([
      promise.then(() => "closed"),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("open"), timeoutMs);
      }),
    ]);
    assert.equal(result, "open");
  } finally {
    clearTimeout(timeout);
  }
}
