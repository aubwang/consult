import { newSession as defaultNewSession, startAgent as defaultStartAgent } from "./acp-client.mts";
import type { JobAuthorityDiagnostic } from "./job-authority.mts";
import type {
  JobAuthorityPreflightInput,
  JobAuthorityPreflightResult,
} from "./job-authority-preflight.mts";

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

export interface ClaudeHostRefreshDeps {
  startAgent?: typeof defaultStartAgent;
  newSession?: typeof defaultNewSession;
  timeoutMs?: number;
}

export async function refreshClaudeHostOauth(
  input: JobAuthorityPreflightInput,
  deps: ClaudeHostRefreshDeps = {},
): Promise<void> {
  if (input.profileRegistryId !== "claude" || !input.profileLaunch) {
    throw new Error("automatic Claude Host refresh requires the exact built-in Claude Profile");
  }

  const agent = await (deps.startAgent ?? defaultStartAgent)({
    binary: input.profileLaunch.binary,
    args: input.profileLaunch.args,
    env: input.profileLaunch.env,
    cwd: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    mode: "read-only",
    sandbox: "off",
    profileRegistryId: "claude",
  });
  let failure: unknown;
  try {
    await withTimeout(
      (deps.newSession ?? defaultNewSession)(agent.connection, {
        cwd: input.workspaceRoot,
      }),
      deps.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await agent.dispose();
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
      else noteCleanupFailure(failure, cleanupError);
    }
  }
  if (failure !== undefined) throw failure;
}

export interface ClaudeRefreshPreflightDeps {
  allowHostRefresh: boolean;
  preflight(
    input: JobAuthorityPreflightInput,
  ): Promise<JobAuthorityPreflightResult>;
  refresh?: typeof refreshClaudeHostOauth;
}

export async function preflightWithClaudeHostRefresh(
  input: JobAuthorityPreflightInput,
  deps: ClaudeRefreshPreflightDeps,
): Promise<JobAuthorityPreflightResult> {
  const initial = await deps.preflight(input);
  if (
    initial.ok ||
    !deps.allowHostRefresh ||
    input.profileRegistryId !== "claude" ||
    !isExpiredClaudeOauth(initial.diagnostic)
  ) {
    return initial;
  }

  try {
    await (deps.refresh ?? refreshClaudeHostOauth)(input);
  } catch {
    return {
      ok: false,
      diagnostic: refreshFailure(
        initial.diagnostic,
        "automatic Claude Host credential refresh failed before Job creation",
      ),
    };
  }

  const retried = await deps.preflight(input);
  if (!retried.ok && isExpiredClaudeOauth(retried.diagnostic)) {
    return {
      ok: false,
      diagnostic: refreshFailure(
        retried.diagnostic,
        "Claude OAuth credential remained expired after one automatic Host refresh attempt",
      ),
    };
  }
  return retried;
}

function isExpiredClaudeOauth(diagnostic: JobAuthorityDiagnostic): boolean {
  return diagnostic.details?.credentialKind === "claude-oauth" &&
    diagnostic.details?.credentialState === "expired";
}

function refreshFailure(
  diagnostic: JobAuthorityDiagnostic,
  message: string,
): JobAuthorityDiagnostic {
  return {
    ...diagnostic,
    message,
    remediation:
      "Run `claude auth login` once to restore the Host login, then retry. To stop hitting this repeatedly, set a long-lived CONSULT_CLAUDE_OAUTH_TOKEN (generate one with `claude setup-token`) or CONSULT_CLAUDE_API_KEY in the Host environment. No Job was created.",
    details: {
      ...diagnostic.details,
      refreshAttempted: true,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("automatic Claude Host credential refresh timed out")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function noteCleanupFailure(primary: unknown, cleanup: unknown): void {
  if (!(primary instanceof Error)) return;
  Object.defineProperty(primary, "cleanupError", {
    configurable: true,
    enumerable: false,
    value: cleanup,
  });
}
