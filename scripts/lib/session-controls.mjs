import {
  loadSession,
  resumeSession,
  setSessionConfigOption,
  setSessionModel,
} from "./acp-client.mjs";

export async function applySessionControls(
  connection,
  { sessionId, sessionState, model, effort, profile },
) {
  let nextState = sessionState ?? {};
  if (model) {
    nextState = await applyModelControl(connection, {
      sessionId,
      sessionState: nextState,
      model,
      profile,
    });
  }
  if (effort) {
    nextState = await applyEffortControl(connection, {
      sessionId,
      sessionState: nextState,
      effort,
      profile,
    });
  }
  return nextState;
}

export async function openResumedSession(connection, capabilities, params) {
  if (supportsResume(capabilities)) {
    return await resumeSession(connection, params);
  }
  if (supportsLoad(capabilities)) {
    return await loadSession(connection, params);
  }
  const error = new Error(
    "delegate --resume requested, but the agent did not advertise session/resume or session/load",
  );
  error.code = "RESUME_UNSUPPORTED";
  throw error;
}

export function supportsResume(capabilities) {
  const agentCapabilities = capabilities?.agentCapabilities ?? {};
  return (
    agentCapabilities.sessionCapabilities?.resume !== undefined ||
    agentCapabilities.sessions?.resume === true
  );
}

export function supportsLoad(capabilities) {
  return capabilities?.agentCapabilities?.loadSession === true;
}

async function applyModelControl(connection, { sessionId, sessionState, model, profile }) {
  const modelId = normalizeModelControl(profile, model);
  if (sessionState?.models) {
    await setSessionModel(connection, { sessionId, modelId });
    return sessionState;
  }

  const option = findConfigOption(sessionState?.configOptions, {
    category: "model",
    fallbackPattern: /model/i,
  });
  if (!option) {
    throw unsupportedControlError(profile, "model", "model selection");
  }
  return await setConfigControl(connection, {
    sessionId,
    sessionState,
    option,
    requestedValue: modelId,
    controlName: "model",
  });
}

export function normalizeModelControl(profile, model) {
  if (profile !== "claude") {
    return model;
  }
  const normalized = model.toLowerCase().replaceAll("_", "-");
  return CLAUDE_MODEL_ALIASES[normalized] ?? model;
}

const CLAUDE_MODEL_ALIASES = {
  opus: "claude-opus-4-8",
  "claude-opus": "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-opus-4-8": "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  "claude-sonnet": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  "claude-haiku": "claude-haiku-4-5",
  "haiku-4.5": "claude-haiku-4-5",
  "haiku-4-5": "claude-haiku-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
};

async function applyEffortControl(connection, { sessionId, sessionState, effort, profile }) {
  const option = findConfigOption(sessionState?.configOptions, {
    category: "thought_level",
    fallbackPattern: /effort|reasoning|thought/i,
  });
  if (!option) {
    throw unsupportedControlError(profile, "effort", "thought_level configuration");
  }
  return await setConfigControl(connection, {
    sessionId,
    sessionState,
    option,
    requestedValue: effort,
    controlName: "effort",
  });
}

async function setConfigControl(
  connection,
  { sessionId, sessionState, option, requestedValue, controlName },
) {
  if (option.type !== "select") {
    throw new Error(
      `${controlName} selection requires a select configuration option, got '${option.type}'`,
    );
  }
  const value = resolveSelectValue(option, requestedValue, controlName);
  const response = await setSessionConfigOption(connection, {
    sessionId,
    configId: option.id,
    value,
  });
  return {
    ...sessionState,
    configOptions: response?.configOptions ?? sessionState?.configOptions,
  };
}

function findConfigOption(configOptions, { category, fallbackPattern }) {
  if (!Array.isArray(configOptions)) {
    return null;
  }
  return (
    configOptions.find((option) => option?.category === category) ??
    configOptions.find((option) =>
      fallbackPattern.test(`${option?.id ?? ""} ${option?.name ?? ""}`),
    ) ??
    null
  );
}

function resolveSelectValue(option, requestedValue, controlName) {
  const options = flattenSelectOptions(option.options);
  const exactMatch = options.find((candidate) => candidate.value === requestedValue);
  if (exactMatch) {
    return exactMatch.value;
  }
  const normalized = requestedValue.toLowerCase();
  const relaxedMatch = options.find(
    (candidate) =>
      candidate.value.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
  );
  if (relaxedMatch) {
    return relaxedMatch.value;
  }
  const available = options.map((candidate) => candidate.value).join(", ");
  throw new Error(
    `unsupported ${controlName} '${requestedValue}'${available ? `; available values: ${available}` : ""}`,
  );
}

function flattenSelectOptions(options = []) {
  return options.flatMap((entry) => {
    if (Array.isArray(entry?.options)) {
      return entry.options;
    }
    return entry ? [entry] : [];
  });
}

function unsupportedControlError(profile, flagName, requiredControl) {
  const error = new Error(
    `profile '${profile}' does not support --${flagName}: agent did not advertise ${requiredControl}`,
  );
  error.code = `${flagName.toUpperCase()}_UNSUPPORTED`;
  return error;
}
