import os from "node:os";

import { cancelPrompt } from "./acp-client.mts";
import type { StartedAgent } from "./acp-client.mts";
import { createBrokerJobRuntime } from "./broker-job-runtime.mts";
import type { BrokerJob, BrokerJobSocketLike } from "./broker-job-runtime.mts";
import type { BrokerProfileEntry } from "./broker-lifecycle.mts";
import {
  agentErrorMessage,
  canonicalizeRunParams,
  hashRunPayload,
  runAgentJobTurn,
  startJobAgent,
} from "./job-agent.mts";
import type {
  AgentSessionState,
  CanonicalConsultRunParams,
  CodedAgentError,
} from "./job-agent.mts";
import { assertMatchingJobAuthority } from "./job-authority.mts";
import type { JobAuthority } from "./job-authority.mts";
import {
  finalizedBrokerJobRecord,
  finalizeJobRecord,
  isFinalStatus,
  readWorkspaceJobRecord,
  writeJobRecord,
} from "./job-records.mts";
import type { BrokerJobSnapshot, FinalizedJobOutcome, JobRecord } from "./job-records.mts";
import { normalizeAgentSandbox } from "./process-sandbox.mts";
import { supportsLoad, supportsResume } from "./session-controls.mts";
import type {
  EnsureBrokerSessionInput,
  EnsureBrokerSessionResult,
  PromptTurnBrokerClient,
} from "./prompt-turn-runner.mts";

import type { ConsultRunParams } from "../consult-broker.mts";

// Foreground `consult delegate` runs its single prompt turn in-process: the
// companion spawns the ACP agent directly instead of dialing a job-scoped
// Broker daemon (ADR-0021). The client returned here speaks the same
// consult/run + consult/update + consult/finalized contract the Broker socket
// client speaks, so prompt-turn-runner drives both paths identically, and it
// shares the Broker's job runtime and agent wiring so permission policy,
// records, and logs stay byte-for-byte compatible.

export const INLINE_CANCEL_ACK_TIMEOUT_MS = 2000;

export async function ensureInlineSession(
  input: EnsureBrokerSessionInput,
): Promise<EnsureBrokerSessionResult> {
  return { client: createInlineClient(input) };
}

export function createInlineClient({
  workspaceRoot,
  executionRoot = workspaceRoot,
  host,
  hostSessionId,
  profile,
  authority: expectedAuthority,
  profileEntry,
  cancelAckTimeoutMs = INLINE_CANCEL_ACK_TIMEOUT_MS,
}: EnsureBrokerSessionInput & { cancelAckTimeoutMs?: number }): PromptTurnBrokerClient {
  const entry = profileEntry as BrokerProfileEntry;
  const sandbox = normalizeAgentSandbox(process.env.CONSULT_AGENT_SANDBOX);
  const handlers = new Map<string, (notification: unknown) => void>();
  // The runtime's subscriber "socket" is an in-process sink; nothing closes it.
  const sink: BrokerJobSocketLike = { once: () => sink };
  let agent: StartedAgent | null = null;
  let disposeStarted = false;
  let disposeDone: Promise<void> = Promise.resolve();
  let job: BrokerJob | null = null;
  let pendingJobId: string | null = null;
  let sessionId: string | undefined;
  let sessionState: AgentSessionState | null = null;
  let signalled = false;
  let finalizedDispatched = false;
  let finalizedResolve!: () => void;
  const finalized = new Promise<void>((resolve) => {
    finalizedResolve = resolve;
  });

  const runtime = createBrokerJobRuntime({
    config: {
      cwd: executionRoot,
      stateWorkspaceRoot: workspaceRoot,
      host: host ?? "terminal",
      hostSessionId: hostSessionId ?? "default",
      cancelAckTimeoutMs,
    },
    ensureAgent,
    hashRunPayload,
    writeNotification: (_socket, method, params) => {
      if (method === "consult/finalized") {
        finalizedDispatched = true;
        finalizedResolve();
        void settleAndDispatch(method, params);
        return;
      }
      handlers.get(method)?.(params);
    },
  });

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    async request(method, params) {
      if (method === "consult/run") {
        return await handleRun(params as unknown as ConsultRunParams);
      }
      const error = new Error(`method not found: ${method}`) as CodedAgentError;
      error.code = "BROKER_ERROR";
      throw error;
    },
    on(method, handler) {
      handlers.set(method, handler);
    },
    // The transport is in-process; there is no connection that can drop.
    onClose() {},
  };

  async function handleRun(params: ConsultRunParams): Promise<unknown> {
    let canonicalParams: CanonicalConsultRunParams;
    try {
      canonicalParams = canonicalizeRunParams(params);
      assertMatchingJobAuthority(canonicalParams.authority, expectedAuthority);
      pendingJobId = canonicalParams.jobId;
      if (canonicalParams.resume) {
        const resumeAgent = await ensureAgent(
          canonicalParams.authority,
          canonicalParams.jobId,
        );
        if (!supportsResume(resumeAgent.capabilities) && !supportsLoad(resumeAgent.capabilities)) {
          const error = new Error(
            `profile '${canonicalParams.profile}' does not support delegate --resume: agent did not advertise session/resume or session/load`,
          ) as CodedAgentError;
          error.code = "RESUME_UNSUPPORTED";
          throw error;
        }
      }
    } catch (error) {
      await disposeAgent();
      removeSignalHandlers();
      throw error;
    }

    const acceptedJob = runtime.createJob(canonicalParams, sink);
    job = acceptedJob;
    runtime.attachJob(acceptedJob, sink);
    runAgentJobTurn(canonicalParams, acceptedJob, {
      config: { cwd: executionRoot },
      ensureAgent,
      getSession: () => sessionId,
      getSessionState: () => sessionState ?? undefined,
      setSession: (nextSessionId, nextSessionState = null) => {
        sessionId = nextSessionId;
        if (nextSessionState) {
          sessionState = nextSessionState;
        }
      },
      trackSession: (id, trackedJob) => runtime.trackSession(id, trackedJob),
      finalizeJob: (turnJob, outcome) => runtime.finalizeJob(turnJob, outcome),
      noteTurnSettled: (turnJob) => runtime.noteTurnSettled(turnJob),
    }).catch(async (error) => {
      await runtime.failJob(acceptedJob, agentErrorMessage(error as CodedAgentError)).catch(() => {});
      if (!finalizedDispatched) {
        // failJob early-returns on a job the runtime already marked finalized
        // whose record write then failed; never leave the turn unresolved or
        // the companion would hang awaiting consult/finalized.
        finalizedDispatched = true;
        finalizedResolve();
        void settleAndDispatch("consult/finalized", {
          jobId: acceptedJob.jobId,
          stopReason: "failed",
          sessionId: acceptedJob.sessionId,
          errorMessage: agentErrorMessage(error as CodedAgentError),
        });
      }
    });
    return { accepted: true, jobId: canonicalParams.jobId };
  }

  async function ensureAgent(
    authority: JobAuthority,
    jobId: string | null = null,
  ): Promise<StartedAgent> {
    // One inline client runs exactly one job in exactly one mode, so unlike
    // the Broker there is never a mode change requiring an agent restart.
    if (!agent) {
      agent = await startJobAgent({
        binary: entry.binary,
        args: entry.args ?? [],
        env: entry.env ?? {},
        cwd: executionRoot,
        stateWorkspaceRoot: workspaceRoot,
        authority,
        sandbox,
        profileRegistryId: entry.registryId ?? profile,
        jobId,
        runtime,
      });
    }
    return agent;
  }

  async function settleAndDispatch(method: string, params: unknown): Promise<void> {
    // The companion exits right after the turn settles; dispose the agent
    // child before surfacing finalization so nothing outlives the dispatch.
    try {
      await disposeAgent();
    } finally {
      if (job) {
        runtime.noteTurnSettled(job);
      }
      removeSignalHandlers();
      handlers.get(method)?.(params);
    }
  }

  function disposeAgent(): Promise<void> {
    if (agent && !disposeStarted) {
      disposeStarted = true;
      const current = agent;
      disposeDone = current.dispose().catch(() => {});
    }
    return disposeDone;
  }

  function onSignal(signal: NodeJS.Signals): void {
    if (signalled) {
      return;
    }
    signalled = true;
    handleSignal()
      .catch(() => {})
      .finally(() => {
        removeSignalHandlers();
        // Keep the process alive long enough for the caller's isolated-workspace
        // finalization/finally path to persist its patch and remove the worktree.
        // With the agent disposed there are no long-lived handles, so setting the
        // conventional signal exit code still lets the companion exit promptly.
        process.exitCode = signalExitCode(signal);
      });
  }

  function removeSignalHandlers(): void {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  async function handleSignal(): Promise<void> {
    const activeJob = job;
    if (activeJob && activeJob.status === "running") {
      if (activeJob.sessionId && agent && !disposeStarted) {
        cancelPrompt(agent.connection, { sessionId: activeJob.sessionId }).catch(() => {});
      }
      const settled = await Promise.race([
        finalized.then(() => true),
        delay(cancelAckTimeoutMs).then(() => false),
      ]);
      if (!settled) {
        const forcedOutcome = await writeForcedCancelRecord(activeJob);
        if (!finalizedDispatched) {
          finalizedDispatched = true;
          finalizedResolve();
          await settleAndDispatch("consult/finalized", {
            jobId: activeJob.jobId,
            ...forcedOutcome,
            errorMessage: "cancelled before the agent acknowledged session/cancel",
          });
        }
      }
    } else if (!activeJob && pendingJobId) {
      // Signalled during agent cold start (e.g. the resume precheck): no
      // runtime job exists yet, but the queued record must still settle as
      // cancelled instead of staying queued forever.
      await writeQueuedCancelRecord(pendingJobId);
    }
    await disposeAgent();
  }

  async function writeQueuedCancelRecord(jobId: string): Promise<void> {
    const existing: JobRecord | null = await readWorkspaceJobRecord(workspaceRoot, jobId).catch(
      () => null,
    );
    if (!existing || isFinalStatus(existing.status)) {
      return;
    }
    finalizeJobRecord(existing, {
      stopReason: "cancelled",
      errorMessage: "cancelled before the agent started",
    });
    await writeJobRecord(workspaceRoot, jobId, existing).catch(() => {});
  }

  async function writeForcedCancelRecord(
    activeJob: BrokerJob,
  ): Promise<FinalizedJobOutcome> {
    // The agent did not acknowledge session/cancel in time; the signal exit
    // still settles the record as cancelled (ADR-0021).
    activeJob.status = "finalized";
    activeJob.completedAt = new Date().toISOString();
    const finalizedOutcome: FinalizedJobOutcome = {
      stopReason: "cancelled",
      sessionId: activeJob.sessionId ?? undefined,
    };
    const existing: JobRecord = await readWorkspaceJobRecord(workspaceRoot, activeJob.jobId).catch(
      () => ({}),
    );
    const record = finalizedBrokerJobRecord(
      existing,
      activeJob as BrokerJobSnapshot,
      finalizedOutcome,
    );
    record.errorMessage = "cancelled before the agent acknowledged session/cancel";
    await writeJobRecord(workspaceRoot, activeJob.jobId, record).catch(() => {});
    return finalizedOutcome;
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osSignalNumber(signal) ?? 1);
}

function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  return (os.constants.signals as Record<string, number | undefined>)[signal];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
