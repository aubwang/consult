import { stringFlag } from "./args.mjs";

export const HOST_ENV = "CONSULT_HOST";
export const HOST_SESSION_ENV = "CONSULT_HOST_SESSION_ID";
export const DEFAULT_HOST = "terminal";
export const DEFAULT_HOST_SESSION_ID = "default";

export function resolveHostIdentity({
  args = {},
  env = process.env,
  defaultHost = DEFAULT_HOST,
  defaultHostSessionId = DEFAULT_HOST_SESSION_ID,
} = {}) {
  const host = stringFlag(args.flags?.host) ?? env[HOST_ENV] ?? defaultHost;
  const hostSessionId =
    stringFlag(args.flags?.["host-session"]) ??
    stringFlag(args.flags?.["host-session-id"]) ??
    env[HOST_SESSION_ENV] ??
    defaultHostSessionId;

  return {
    host,
    hostSessionId,
  };
}
