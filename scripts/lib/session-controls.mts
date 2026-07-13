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
  const normalizedModel = normalizeModelControl(profile, model);
  const requestedModel = profile === "codex" ? normalizedModel : model;
  if (sessionState?.models) {
    const advertised = advertisedModelIds(sessionState.models);
    const modelId =
      resolveAdvertisedModel(
        requestedModel,
        advertised,
        currentAdvertisedModelId(sessionState.models),
      ) ??
      normalizedModel;
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
    requestedValue: requestedModel,
    fallbackValue: normalizedModel,
    controlName: "model",
  });
}

// SessionModelState in the ACP SDK is { availableModels: ModelInfo[],
// currentModelId }, with ModelInfo carrying a `modelId` string. Agents vary,
// so extract advertised ids defensively.
function advertisedModelIds(models: unknown): string[] {
  const availableModels = (models as { availableModels?: unknown } | null)?.availableModels;
  if (!Array.isArray(availableModels)) {
    return [];
  }
  return availableModels.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    const modelId = (entry as { modelId?: unknown; id?: unknown } | null)?.modelId;
    if (typeof modelId === "string") {
      return [modelId];
    }
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

function currentAdvertisedModelId(models: unknown): string | null {
  const currentModelId = (models as { currentModelId?: unknown } | null)?.currentModelId;
  return typeof currentModelId === "string" ? currentModelId : null;
}

function resolveAdvertisedModel(
  requested: string,
  advertised: string[],
  currentModelId: string | null,
): string | null {
  if (advertised.includes(requested)) {
    return requested;
  }
  const normalized = requested.toLowerCase().replaceAll("_", "-");
  const relaxed = advertised.find((id) => id.toLowerCase() === normalized);
  if (relaxed) {
    return relaxed;
  }
  const decorated = advertised.filter(
    (id) => decoratedModelId(id)?.model.toLowerCase() === normalized,
  );
  if (decorated.length > 0) {
    const currentEffort = currentModelId === null
      ? null
      : decoratedModelId(currentModelId)?.effort ?? null;
    return decorated.find((id) => decoratedModelId(id)?.effort === currentEffort) ?? decorated[0];
  }
  return resolveFamilyLatest(requested, advertised);
}

function decoratedModelId(modelId: string): { model: string; effort: string } | null {
  const match = /^(?<model>.+)\[(?<effort>[^\]]+)\]$/u.exec(modelId);
  return match?.groups
    ? { model: match.groups.model, effort: match.groups.effort }
    : null;
}

// A family or tier alias is a bare name with no version digits ("sonnet",
// "claude-sonnet", "sol", "terra", "luna"); resolve it to the newest
// advertised id containing that token. Newest compares numeric segments parsed
// from the id, so
// claude-sonnet-5 beats claude-sonnet-4-6 and a date suffix acts as an extra,
// less-significant segment.
export function resolveFamilyLatest(requested: string, candidates: string[]): string | null {
  const token = requested.toLowerCase().replaceAll("_", "-");
  if (!token || /\d/.test(token)) {
    return null;
  }
  const matches = candidates.filter((id) => id.toLowerCase().includes(token));
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((newest, candidate) =>
    compareModelVersions(candidate, newest) > 0 ? candidate : newest,
  );
}

function compareModelVersions(a: string, b: string): number {
  const left = versionSegments(a);
  const right = versionSegments(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? -1) - (right[index] ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function versionSegments(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

export function normalizeModelControl(profile: string, model: string): string {
  const normalized = model.toLowerCase().replaceAll("_", "-");
  if (profile === "claude") {
    return CLAUDE_MODEL_ALIASES[normalized] ?? model;
  }
  if (profile === "codex") {
    return CODEX_MODEL_ALIASES[normalized] ?? model;
  }
  return model;
}

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  "claude-opus": "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-opus-4-8": "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  "claude-sonnet": "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5",
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
  fable: "claude-fable-5",
  "claude-fable": "claude-fable-5",
  "fable-5": "claude-fable-5",
  "claude-fable-5": "claude-fable-5",
};

const CODEX_MODEL_ALIASES: Record<string, string> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
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
    fallbackValue,
    controlName,
  }: {
    sessionId: string;
    sessionState: SessionControlsState;
    option: SessionConfigOptionLike;
    requestedValue: string;
    fallbackValue?: string;
    controlName: string;
  },
): Promise<SessionControlsState> {
  if (option.type !== "select") {
    throw new Error(
      `${controlName} selection requires a select configuration option, got '${option.type}'`,
    );
  }
  const value = resolveSelectValue(option, requestedValue, controlName, fallbackValue);
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
  fallbackValue?: string,
): string {
  const options = flattenSelectOptions(option.options);
  const directMatch = matchSelectOption(options, requestedValue);
  if (directMatch) {
    return directMatch.value;
  }
  const familyLatest = resolveFamilyLatest(
    requestedValue,
    options.map((candidate) => candidate.value),
  );
  if (familyLatest !== null) {
    return familyLatest;
  }
  if (fallbackValue !== undefined && fallbackValue !== requestedValue) {
    const fallbackMatch = matchSelectOption(options, fallbackValue);
    if (fallbackMatch) {
      return fallbackMatch.value;
    }
  }
  const available = options.map((candidate) => candidate.value).join(", ");
  throw new Error(
    `unsupported ${controlName} '${requestedValue}'${available ? `; available values: ${available}` : ""}`,
  );
}

function matchSelectOption(
  options: SessionConfigSelectOptionLike[],
  requestedValue: string,
): SessionConfigSelectOptionLike | null {
  const exactMatch = options.find((candidate) => candidate.value === requestedValue);
  if (exactMatch) {
    return exactMatch;
  }
  const normalized = requestedValue.toLowerCase();
  return (
    options.find(
      (candidate) =>
        candidate.value.toLowerCase() === normalized ||
        candidate.name.toLowerCase() === normalized,
    ) ?? null
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
