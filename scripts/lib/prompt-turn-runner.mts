import {
  appendJobLogLine as defaultAppendLogLine,
  failJobRecord,
  finalizeJobRecord,
  markJobRunning,
  writeJobRecord as defaultWriteJobRecord,
} from "./job-records.mts";
import type { JobRecord } from "./job-records.mts";
import { appendBoundedText, DEFAULT_MAX_FINAL_TEXT_CHARS } from "./bounded-text.mts";
import { ensureBrokerSession as defaultEnsureBrokerSession } from "./broker-lifecycle.mts";
import { createNullOutput } from "./null-output.mts";
import type { NullOutput, NullOutputResult } from "./null-output.mts";
import { omitUndefined } from "./objects.mts";
import { extractAgentMessageText } from "./session-update-renderer.mts";

export interface PromptTurnBrokerClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  on(method: string, handler: (notification: unknown) => void): void;
  onClose?(handler: (error: unknown) => void): unknown;
}

export interface EnsureBrokerSessionInput {
  /** Original Workspace identity used for Job/Broker state. */
  workspaceRoot: string;
  /** Optional detached worktree used as the Profile's cwd and confinement root. */
  executionRoot?: string;
  jobId?: string;
  host?: string;
  hostSessionId?: string;
  profile?: string;
  profileEntry: unknown;
}

export interface EnsureBrokerSessionResult {
  client: PromptTurnBrokerClient;
}

export interface FinalizedNotification {
  stopReason?: string;
  sessionId?: string;
  touchedFiles?: string[];
  errorMessage?: string;
}

export interface PromptTurnContext {
  readonly finalText: string;
  finalized: Promise<FinalizedNotification>;
  disconnected: Promise<unknown>;
  notificationChain: () => Promise<unknown>;
}

export interface PromptTurnDeps {
  now?: () => string;
  writeJobRecord?: (workspaceRoot: string, jobId: string, record: JobRecord) => Promise<void>;
  appendLogLine?: (
    workspaceRoot: string,
    jobId: string,
    notification: unknown,
  ) => Promise<void>;
  maxFinalTextChars?: number;
  ensureBrokerSession?: (
    input: EnsureBrokerSessionInput,
  ) => Promise<EnsureBrokerSessionResult>;
}

export interface AfterAcceptedInput {
  accepted: unknown;
  client: PromptTurnBrokerClient;
  context: PromptTurnContext;
  output: NullOutput;
}

export interface PromptTurnSuccess {
  accepted: unknown;
  client: PromptTurnBrokerClient;
  finalNotification: FinalizedNotification;
  finalText: string;
}

export interface RunPromptTurnOptions {
  workspaceRoot: string;
  executionRoot?: string;
  profileEntry: unknown;
  jobRecord: JobRecord;
  prompt?: string;
  payloadFields?: Record<string, unknown>;
  deps?: PromptTurnDeps;
  output?: NullOutput;
  renderUpdate?: (notification: unknown) => string;
  extractFinalText?: (notification: unknown) => string;
  onUpdate?: ((notification: unknown, context: PromptTurnContext) => void) | null;
  afterAccepted?:
    | ((input: AfterAcceptedInput) => Promise<NullOutputResult | null | undefined | void>)
    | null;
  markFailedOnBrokerError?: boolean;
}

interface BrokerErrorLike {
  code?: string;
  message: string;
}

export async function runPromptTurn({
  workspaceRoot,
  executionRoot,
  profileEntry,
  jobRecord,
  prompt,
  payloadFields = {},
  deps = {},
  output = createNullOutput(),
  renderUpdate = () => "",
  extractFinalText = extractAgentMessageText as (notification: unknown) => string,
  onUpdate = null,
  afterAccepted = null,
  markFailedOnBrokerError = false,
}: RunPromptTurnOptions): Promise<PromptTurnSuccess | NullOutputResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const appendLogLine = deps.appendLogLine ?? defaultAppendLogLine;
  const maxFinalTextChars = deps.maxFinalTextChars ?? DEFAULT_MAX_FINAL_TEXT_CHARS;

  const { client } = await (deps.ensureBrokerSession ??
    (defaultEnsureBrokerSession as (
      input: EnsureBrokerSessionInput,
    ) => Promise<EnsureBrokerSessionResult>))({
    workspaceRoot,
    executionRoot,
    jobId: jobRecord.jobId,
    host: jobRecord.host,
    hostSessionId: jobRecord.hostSessionId,
    profile: jobRecord.profile,
    profileEntry,
  });

  let sawUpdate = false;
  let finalizedSeen = false;
  let finalText = "";
  let notificationChain: Promise<unknown> = Promise.resolve();
  let disconnectedResolve!: (error: unknown) => void;
  let finalizedResolve!: (notification: FinalizedNotification) => void;
  const disconnected = new Promise<unknown>((resolve) => {
    disconnectedResolve = resolve;
  });
  const finalized = new Promise<FinalizedNotification>((resolve) => {
    finalizedResolve = resolve;
  });
  const context: PromptTurnContext = {
    get finalText() {
      return finalText;
    },
    finalized,
    disconnected,
    notificationChain: () => notificationChain,
  };

  client.onClose?.((error) => {
    if (!finalizedSeen) {
      disconnectedResolve(error);
    }
  });

  // One failed log/record write must not poison the chain and block finalization.
  const reportWriteFailure = (error: unknown) => {
    output.stderr(`job record write failed: ${(error as Error).message}\n`);
  };

  client.on("consult/update", (notification) => {
    onUpdate?.(notification, context);
    notificationChain = notificationChain.then(async () => {
      await appendLogLine(workspaceRoot, jobRecord.jobId!, {
        method: "consult/update",
        params: notification,
      }).catch(reportWriteFailure);
      if (!sawUpdate) {
        sawUpdate = true;
        markJobRunning(jobRecord, { now });
        await writeJobRecord(workspaceRoot, jobRecord.jobId!, jobRecord).catch(reportWriteFailure);
      }
      const agentText = extractFinalText(notification);
      if (agentText) {
        finalText = appendBoundedText(finalText, agentText, { maxChars: maxFinalTextChars });
      }
      const rendered = renderUpdate(notification);
      if (rendered) {
        output.stdout(rendered);
      }
    });
  });

  client.on("consult/finalized", (notification) => {
    finalizedSeen = true;
    const finalizedNotification = notification as FinalizedNotification;
    notificationChain = notificationChain.then(async () => {
      await appendLogLine(workspaceRoot, jobRecord.jobId!, {
        method: "consult/finalized",
        params: notification,
      }).catch(reportWriteFailure);
      finalizeJobRecord(jobRecord, {
        now,
        stopReason: finalizedNotification.stopReason,
        sessionId: finalizedNotification.sessionId,
        touchedFiles: finalizedNotification.touchedFiles,
        finalText,
        errorMessage: finalizedNotification.errorMessage,
      });
      await writeJobRecord(workspaceRoot, jobRecord.jobId!, jobRecord).catch(reportWriteFailure);
      finalizedResolve(finalizedNotification);
    });
  });

  let accepted: unknown;
  try {
    accepted = await client.request("consult/run", omitUndefined({
      jobId: jobRecord.jobId,
      kind: jobRecord.kind,
      mode: jobRecord.mode,
      host: jobRecord.host,
      hostSessionId: jobRecord.hostSessionId,
      profile: jobRecord.profile,
      submittedAt: jobRecord.submittedAt,
      chainId: jobRecord.chainId,
      parentJobId: jobRecord.parentJobId,
      delegationDepth: jobRecord.delegationDepth,
      resume: jobRecord.resumeSessionId ?? null,
      prompt: prompt ?? jobRecord.prompt,
      model: jobRecord.model,
      effort: jobRecord.effort,
      allowExecute: jobRecord.allowExecute === true ? true : undefined,
      ...payloadFields,
    }));
  } catch (error) {
    const brokerError = error as BrokerErrorLike;
    const exitCode = exitCodeForBrokerError(brokerError.code);
    const message = brokerErrorMessage(brokerError);
    if (markFailedOnBrokerError) {
      failJobRecord(jobRecord, { now, errorMessage: message });
      await writeJobRecord(workspaceRoot, jobRecord.jobId!, jobRecord);
    }
    output.stderr(`${message}\n`);
    return output.result(exitCode);
  }

  if (!(accepted as { accepted?: unknown } | null | undefined)?.accepted) {
    const message = `Broker did not accept ${jobRecord.kind} job`;
    if (markFailedOnBrokerError) {
      failJobRecord(jobRecord, { now, errorMessage: message });
      await writeJobRecord(workspaceRoot, jobRecord.jobId!, jobRecord);
    }
    output.stderr(`${message}\n`);
    return output.result(3);
  }

  const earlyResult = await afterAccepted?.({
    accepted,
    client,
    context,
    output,
  });
  if (earlyResult) {
    return earlyResult;
  }

  let finalNotification: FinalizedNotification;
  try {
    finalNotification = await Promise.race([
      finalized,
      disconnected.then((error) => {
        throw error;
      }),
    ]);
  } catch (error) {
    const brokerError = error as BrokerErrorLike;
    const message = brokerErrorMessage(brokerError);
    failJobRecord(jobRecord, { now, errorMessage: message, finalText });
    await notificationChain;
    await writeJobRecord(workspaceRoot, jobRecord.jobId!, jobRecord);
    output.stderr(`${message}\n`);
    return output.result(exitCodeForBrokerError(brokerError.code));
  }

  await notificationChain;
  return { accepted, client, finalNotification, finalText };
}

export function exitCodeForBrokerError(code: string | undefined): number {
  return ["BROKER_BUSY", "BROKER_TAINTED", "JOB_CONFLICT", "JOB_FINALIZED"].includes(code as string)
    ? 3
    : 1;
}

export function brokerErrorMessage(error: BrokerErrorLike): string {
  const base = error.code ? `${error.code}: ${error.message}` : error.message;
  if (
    [
      "BROKER_DISCONNECTED",
      "BROKER_UNREACHABLE",
      "BROKER_STATE_MALFORMED",
      "BROKER_SPAWN_TIMEOUT",
    ].includes(error.code as string)
  ) {
    return `${base}. Inspect Broker state with \`consult brokers\`; remove stale state with \`consult brokers --cleanup\`.`;
  }
  if (error.code) {
    return base;
  }
  return base;
}
