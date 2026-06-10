import { stringFlag } from "./args.mts";

export const HOST_ENV = "CONSULT_HOST";
export const HOST_SESSION_ENV = "CONSULT_HOST_SESSION_ID";
export const DEFAULT_HOST = "terminal";
export const DEFAULT_HOST_SESSION_ID = "default";

export interface HostIdentity {
  host: string;
  hostSessionId: string;
}

export interface ResolveHostIdentityOptions {
  args?: { flags?: Record<string, unknown> };
  env?: Record<string, string | undefined>;
  defaultHost?: string;
  defaultHostSessionId?: string;
}

export function resolveHostIdentity({
  args = {},
  env = process.env,
  defaultHost = DEFAULT_HOST,
  defaultHostSessionId = DEFAULT_HOST_SESSION_ID,
}: ResolveHostIdentityOptions = {}): HostIdentity {
  const explicitHost = stringFlag(args.flags?.host) ?? env[HOST_ENV];
  const explicitHostSessionId =
    stringFlag(args.flags?.["host-session"]) ??
    stringFlag(args.flags?.["host-session-id"]) ??
    env[HOST_SESSION_ENV];
  const detected = detectHostIdentity(env);
  const host = explicitHost ?? detected?.host ?? defaultHost;
  const hostSessionId =
    explicitHostSessionId ??
    (detected?.host === host ? detected.hostSessionId : undefined) ??
    defaultHostSessionId;

  return {
    host,
    hostSessionId,
  };
}

function detectHostIdentity(env: Record<string, string | undefined>): HostIdentity | null {
  const opencodeSessionId = nonEmpty(env.OPENCODE_SESSION_ID) ?? nonEmpty(env.OPENCODE_RUN_ID);
  if (opencodeSessionId) {
    return { host: "opencode", hostSessionId: opencodeSessionId };
  }

  const codexThreadId = nonEmpty(env.CODEX_THREAD_ID);
  if (codexThreadId) {
    return { host: "codex", hostSessionId: codexThreadId };
  }

  const claudeSessionId = nonEmpty(env.CLAUDE_SESSION_ID);
  if (claudeSessionId) {
    return { host: "claude-code", hostSessionId: claudeSessionId };
  }

  return null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
