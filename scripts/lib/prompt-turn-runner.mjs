import {
  appendJobLogLine as defaultAppendLogLine,
  failJobRecord,
  finalizeJobRecord,
  markJobRunning,
  writeJobRecord as defaultWriteJobRecord,
} from "./job-records.mjs";
import { ensureBrokerSession as defaultEnsureBrokerSession } from "./broker-lifecycle.mjs";

export async function runPromptTurn({
  workspaceRoot,
  profileEntry,
  jobRecord,
  prompt,
  payloadFields = {},
  deps = {},
  output = createNullOutput(),
  renderUpdate = () => "",
  onUpdate = null,
  afterAccepted = null,
  markFailedOnBrokerError = false,
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const writeJobRecord = deps.writeJobRecord ?? defaultWriteJobRecord;
  const appendLogLine = deps.appendLogLine ?? defaultAppendLogLine;

  const { client } = await (deps.ensureBrokerSession ?? defaultEnsureBrokerSession)({
    workspaceRoot,
    jobId: jobRecord.jobId,
    host: jobRecord.host,
    hostSessionId: jobRecord.hostSessionId,
    profile: jobRecord.profile,
    profileEntry,
  });

  let sawUpdate = false;
  let finalizedSeen = false;
  let finalText = "";
  let notificationChain = Promise.resolve();
  let disconnectedResolve;
  let finalizedResolve;
  const disconnected = new Promise((resolve) => {
    disconnectedResolve = resolve;
  });
  const finalized = new Promise((resolve) => {
    finalizedResolve = resolve;
  });
  const context = {
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

  client.on("consult/update", (notification) => {
    onUpdate?.(notification, context);
    notificationChain = notificationChain.then(async () => {
      await appendLogLine(workspaceRoot, jobRecord.jobId, {
        method: "consult/update",
        params: notification,
      });
      if (!sawUpdate) {
        sawUpdate = true;
        markJobRunning(jobRecord, { now });
        await writeJobRecord(workspaceRoot, jobRecord.jobId, jobRecord);
      }
      const rendered = renderUpdate(notification);
      if (rendered) {
        finalText += rendered;
        output.stdout(rendered);
      }
    });
  });

  client.on("consult/finalized", (notification) => {
    finalizedSeen = true;
    notificationChain = notificationChain.then(async () => {
      await appendLogLine(workspaceRoot, jobRecord.jobId, {
        method: "consult/finalized",
        params: notification,
      });
      finalizeJobRecord(jobRecord, {
        now,
        stopReason: notification.stopReason,
        sessionId: notification.sessionId,
        touchedFiles: notification.touchedFiles,
        finalText,
        errorMessage: notification.errorMessage,
      });
      await writeJobRecord(workspaceRoot, jobRecord.jobId, jobRecord);
      finalizedResolve(notification);
    });
  });

  let accepted;
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
      ...payloadFields,
    }));
  } catch (error) {
    const exitCode = exitCodeForBrokerError(error.code);
    const message = brokerErrorMessage(error);
    if (markFailedOnBrokerError) {
      failJobRecord(jobRecord, { now, errorMessage: message });
      await writeJobRecord(workspaceRoot, jobRecord.jobId, jobRecord);
    }
    output.stderr(`${message}\n`);
    return output.result(exitCode);
  }

  if (!accepted?.accepted) {
    output.stderr(`Broker did not accept ${jobRecord.kind} job\n`);
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

  let finalNotification;
  try {
    finalNotification = await Promise.race([
      finalized,
      disconnected.then((error) => {
        throw error;
      }),
    ]);
  } catch (error) {
    const message = brokerErrorMessage(error);
    failJobRecord(jobRecord, { now, errorMessage: message, finalText });
    await notificationChain;
    await writeJobRecord(workspaceRoot, jobRecord.jobId, jobRecord);
    output.stderr(`${message}\n`);
    return output.result(exitCodeForBrokerError(error.code));
  }

  await notificationChain;
  return { accepted, client, finalNotification, finalText };
}

export function exitCodeForBrokerError(code) {
  return ["BROKER_BUSY", "BROKER_TAINTED", "JOB_CONFLICT", "JOB_FINALIZED"].includes(code)
    ? 3
    : 1;
}

export function brokerErrorMessage(error) {
  const base = error.code ? `${error.code}: ${error.message}` : error.message;
  if (
    [
      "BROKER_DISCONNECTED",
      "BROKER_UNREACHABLE",
      "BROKER_STATE_MALFORMED",
      "BROKER_SPAWN_TIMEOUT",
    ].includes(error.code)
  ) {
    return `${base}. Inspect Broker state with \`consult brokers\`; remove stale state with \`consult brokers --cleanup\`.`;
  }
  if (error.code) {
    return base;
  }
  return base;
}

function createNullOutput() {
  return {
    stdout() {},
    stderr() {},
    result(exitCode) {
      return { exitCode, stdout: "", stderr: "" };
    },
  };
}

function omitUndefined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
