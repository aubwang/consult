import {
  loadSession,
  resumeSession,
  setSessionConfigOption,
  setSessionModel,
} from "./acp-client.mts";
import type { AcpConnection, ResumeSessionParams } from "./acp-client.mts";
import type {
  InitializeResponse,
  LoadSessionResponse,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk";

// Session state is the loose union of new/resume/load session responses; the
// agent may or may not advertise model state or configuration options.
export interface SessionControlsState {
  models?: unknown;
  configOptions?: SessionConfigOptionLike[] | null;
  [key: string]: unknown;
}

export interface SessionConfigSelectOptionLike {
  name: string;
  value: string;
}

export interface SessionConfigSelectGroupLike {
  options?: SessionConfigSelectOptionLike[];
}

export interface SessionConfigOptionLike {
  id?: string;
  name?: string;
  category?: string | null;
  type?: string;
  options?: Array<SessionConfigSelectOptionLike | SessionConfigSelectGroupLike>;
}

// Both the current ACP capability shape (sessionCapabilities/loadSession) and
// the legacy `sessions` shape some agents still advertise.
export interface SessionCapabilitiesLike {
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: { resume?: unknown };
    sessions?: { resume?: boolean };
  };
}

export interface ApplySessionControlsParams {
  sessionId: string;
  sessionState?: SessionControlsState | null;
  model?: string | null;
  effort?: string | null;
  profile: string;
}

export interface SessionControlError extends Error {
  code: string;
}

export async function applySessionControls(
  connection: AcpConnection,
  { sessionId, sessionState, model, effort, profile }: ApplySessionControlsParams,
): Promise<SessionControlsState> {
  let nextState: SessionControlsState = sessionState ?? {};
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

export async function openResumedSession(
  connection: AcpConnection,
  capabilities: SessionCapabilitiesLike | null | undefined,
  params: ResumeSessionParams,
): Promise<ResumeSessionResponse | LoadSessionResponse> {
  if (supportsResume(capabilities)) {
    return await resumeSession(connection, params);
  }
  if (supportsLoad(capabilities)) {
    return await loadSession(connection, params);
  }
  const error = new Error(
    "delegate --resume requested, but the agent did not advertise session/resume or session/load",
  ) as SessionControlError;
  error.code = "RESUME_UNSUPPORTED";
  throw error;
}

export function supportsResume(
  capabilities: SessionCapabilitiesLike | null | undefined,
): boolean {
  const agentCapabilities = capabilities?.agentCapabilities ?? {};
  return (
    agentCapabilities.sessionCapabilities?.resume !== undefined ||
    agentCapabilities.sessions?.resume === true
  );
}

export function supportsLoad(
  capabilities: SessionCapabilitiesLike | null | undefined,
): boolean {
  return capabilities?.agentCapabilities?.loadSession === true;
}

async function applyModelControl(
  connection: AcpConnection,
  {
    sessionId,
    sessionState,
    model,
    profile,
  }: { sessionId: string; sessionState: SessionControlsState; model: string; profile: string },
): Promise<SessionControlsState> {
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

export function normalizeModelControl(profile: string, model: string): string {
  if (profile !== "claude") {
    return model;
  }
  const normalized = model.toLowerCase().replaceAll("_", "-");
  return CLAUDE_MODEL_ALIASES[normalized] ?? model;
}

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
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

async function applyEffortControl(
  connection: AcpConnection,
  {
    sessionId,
    sessionState,
    effort,
    profile,
  }: { sessionId: string; sessionState: SessionControlsState; effort: string; profile: string },
): Promise<SessionControlsState> {
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
  connection: AcpConnection,
  {
    sessionId,
    sessionState,
    option,
    requestedValue,
    controlName,
  }: {
    sessionId: string;
    sessionState: SessionControlsState;
    option: SessionConfigOptionLike;
    requestedValue: string;
    controlName: string;
  },
): Promise<SessionControlsState> {
  if (option.type !== "select") {
    throw new Error(
      `${controlName} selection requires a select configuration option, got '${option.type}'`,
    );
  }
  const value = resolveSelectValue(option, requestedValue, controlName);
  const response = await setSessionConfigOption(connection, {
    sessionId,
    configId: option.id!,
    value,
  });
  return {
    ...sessionState,
    configOptions: response?.configOptions ?? sessionState?.configOptions,
  };
}

function findConfigOption(
  configOptions: SessionConfigOptionLike[] | null | undefined,
  { category, fallbackPattern }: { category: string; fallbackPattern: RegExp },
): SessionConfigOptionLike | null {
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

function resolveSelectValue(
  option: SessionConfigOptionLike,
  requestedValue: string,
  controlName: string,
): string {
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

function flattenSelectOptions(
  options: Array<SessionConfigSelectOptionLike | SessionConfigSelectGroupLike> = [],
): SessionConfigSelectOptionLike[] {
  return options.flatMap((entry) => {
    if (Array.isArray((entry as SessionConfigSelectGroupLike)?.options)) {
      return (entry as SessionConfigSelectGroupLike).options!;
    }
    return entry ? [entry as SessionConfigSelectOptionLike] : [];
  });
}

function unsupportedControlError(
  profile: string,
  flagName: string,
  requiredControl: string,
): SessionControlError {
  const error = new Error(
    `profile '${profile}' does not support --${flagName}: agent did not advertise ${requiredControl}`,
  ) as SessionControlError;
  error.code = `${flagName.toUpperCase()}_UNSUPPORTED`;
  return error;
}
