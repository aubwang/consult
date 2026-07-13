import assert from "node:assert/strict";
import { test } from "node:test";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import { startAgent } from "./acp-client.mts";
import type {
  AgentLaunchLease,
  StartAgentDeps,
  StartAgentOptions,
  StartedAgent,
} from "./acp-client.mts";
import type { JobAuthority } from "./job-authority.mts";
import { hashRunPayload, startJobAgent } from "./job-agent.mts";
import type { ConfinedSandboxRuntimeLaunchInput } from "./sandbox-runtime-launch.mts";

const BASE_RUN = {
  jobId: "job-1",
  prompt: "run tests",
  profile: "codex",
  mode: "write",
};

test("hashRunPayload includes canonical execute authority", () => {
  const runAuthority = authority({ mode: "write" });
  const defaultHash = hashRunPayload({ ...BASE_RUN, authority: runAuthority });
  const enabledHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...runAuthority, allowExecute: true },
    allowExecute: true,
  });

  assert.notEqual(enabledHash, defaultHash);
});

test("hashRunPayload rejects legacy execute payloads with a stable diagnostic", () => {
  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, allowExecute: true }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_EXECUTE_UNAVAILABLE");
      assert.match((error as Error).message, /legacy execute authority is unavailable/);
      return true;
    },
  );
});

test("hashRunPayload does not treat a string value as execute opt-in", () => {
  assert.equal(
    hashRunPayload({ ...BASE_RUN, allowExecute: "true" as unknown as boolean }),
    hashRunPayload(BASE_RUN),
  );
});

test("hashRunPayload includes canonical confinement and fetch authority", () => {
  const runAuthority = authority({ mode: "write" });
  const confinedHash = hashRunPayload({ ...BASE_RUN, authority: runAuthority });
  const fetchHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...runAuthority, allowFetch: true },
  });
  const inheritedHash = hashRunPayload({
    ...BASE_RUN,
    authority: { ...runAuthority, confinement: "inherit" },
  });

  assert.notEqual(fetchHash, confinedHash);
  assert.notEqual(inheritedHash, confinedHash);
});

test("hashRunPayload binds resume to its source Job archive", () => {
  const first = hashRunPayload({
    ...BASE_RUN,
    resume: "session-shared",
    resumeJobId: "job-first",
  });
  const second = hashRunPayload({
    ...BASE_RUN,
    resume: "session-shared",
    resumeJobId: "job-second",
  });

  assert.notEqual(first, second);
});

test("hashRunPayload canonicalizes authority while ignoring future fields", () => {
  const runAuthority = authority();
  const canonicalHash = hashRunPayload({
    ...BASE_RUN,
    mode: "read-only",
    allowExecute: false,
    authority: runAuthority,
  });
  const extraFieldHash = hashRunPayload({
    ...BASE_RUN,
    mode: "read-only",
    allowExecute: false,
    authority: { ...runAuthority, ignoredFutureField: "compatible" } as typeof runAuthority,
  });

  assert.equal(canonicalHash, extraFieldHash);
});

test("hashRunPayload rejects stale flat compatibility fields", () => {
  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, authority: authority() }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_MISMATCH");
      return true;
    },
  );
});

test("hashRunPayload rejects malformed explicit authority", () => {
  assert.throws(
    () => hashRunPayload({ ...BASE_RUN, authority: null as never }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTHORITY_INVALID");
      return true;
    },
  );
});

test("startJobAgent acquires the confined runtime lease only for confined authority", async () => {
  let capturedOptions: StartAgentOptions | undefined;
  let capturedDeps: StartAgentDeps | undefined;
  let confinedInput: ConfinedSandboxRuntimeLaunchInput | undefined;
  const fakeStartAgent: typeof startAgent = async (options, deps) => {
    capturedOptions = options;
    capturedDeps = deps;
    return {} as StartedAgent;
  };

  await startJobAgent({
    binary: "/profile-agent",
    cwd: "/workspace",
    authority: authority(),
    profileRegistryId: "claude",
    model: "fable",
    runtime: runtimeHooks(authority()),
  }, {
    startAgent: fakeStartAgent,
    acquireConfinedLaunch: async (input) => {
      confinedInput = input;
      return lease(input);
    },
  });

  assert.ok(capturedDeps?.acquireLaunch);
  await capturedDeps.acquireLaunch({
    binary: capturedOptions!.binary,
    args: [],
    cwd: capturedOptions!.cwd,
    env: {},
    workspaceRoot: capturedOptions!.workspaceRoot,
    mode: capturedOptions!.mode,
    sandbox: capturedOptions!.sandbox,
    profileRegistryId: capturedOptions!.profileRegistryId,
    requestedModel: capturedOptions!.requestedModel,
  });
  assert.equal(confinedInput?.authority.confinement, "confined");
  assert.equal(confinedInput?.profileRegistryId, "claude");
  assert.equal(confinedInput?.requestedModel, "claude-fable-5");

  capturedDeps = undefined;
  const inherited = authority({ confinement: "inherit" });
  await startJobAgent({
    binary: "/profile-agent",
    cwd: "/workspace",
    authority: inherited,
    sandbox: "bwrap",
    profileRegistryId: "opencode",
    runtime: runtimeHooks(inherited),
  }, { startAgent: fakeStartAgent });
  assert.equal((capturedDeps as StartAgentDeps | undefined)?.acquireLaunch, undefined);
  assert.equal(capturedOptions?.sandbox, "off");
});

test("startJobAgent does not promote unknown Claude models into the confined launch", async () => {
  let confinedInput: ConfinedSandboxRuntimeLaunchInput | undefined;
  await startJobAgent({
    binary: "/profile-agent",
    cwd: "/workspace",
    env: { ANTHROPIC_MODEL: "ambient-model" },
    authority: authority(),
    profileRegistryId: "claude",
    model: "unknown-model-9",
    runtime: runtimeHooks(authority()),
  }, {
    startAgent: async (options, deps) => {
      await deps!.acquireLaunch!({
        binary: options.binary,
        args: [],
        cwd: options.cwd,
        env: options.env ?? {},
        workspaceRoot: options.workspaceRoot,
        mode: options.mode,
        sandbox: options.sandbox,
        profileRegistryId: options.profileRegistryId,
        requestedModel: options.requestedModel,
      });
      return {} as StartedAgent;
    },
    acquireConfinedLaunch: async (input) => {
      confinedInput = input;
      return lease(input);
    },
  });

  assert.equal(confinedInput?.requestedModel, undefined);
});

test("startJobAgent exposes the fetch grant to ACP permission decisions", async () => {
  let capturedOptions: StartAgentOptions | undefined;
  const granted = authority({ allowFetch: true });
  await startJobAgent({
    binary: "/profile-agent",
    cwd: "/workspace",
    authority: granted,
    profileRegistryId: "claude",
    runtime: runtimeHooks(granted),
  }, {
    startAgent: async (options) => {
      capturedOptions = options;
      return {} as StartedAgent;
    },
    acquireConfinedLaunch: async (input) => lease(input),
  });

  const requestPermission = capturedOptions?.clientHandlers?.requestPermission;
  assert.ok(requestPermission);
  const request: RequestPermissionRequest = {
    sessionId: "session-1",
    options: [],
    toolCall: {
      toolCallId: "fetch-1",
      kind: "fetch",
      rawInput: { url: "https://example.com" },
    },
  };
  assert.deepEqual(await requestPermission(request), {
    outcome: { outcome: "selected", optionId: "allow" },
  });
});

function authority(overrides: Partial<JobAuthority> = {}): JobAuthority {
  return {
    schemaVersion: 1,
    mode: "read-only",
    confinement: "confined",
    allowFetch: false,
    allowExecute: false,
    ...overrides,
  };
}

function runtimeHooks(sessionAuthority: JobAuthority) {
  return {
    async handleSessionUpdate() {},
    getSessionAuthority: () => sessionAuthority,
    notePermissionDecision() {},
  };
}

function lease(input: ConfinedSandboxRuntimeLaunchInput): AgentLaunchLease {
  return {
    launch: {
      binary: input.binary,
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env,
    },
    release: async () => {},
  };
}
