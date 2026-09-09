import { newSession as defaultNewSession, startAgent as defaultStartAgent } from "./acp-client.mts";
import fs from "node:fs/promises";
import path from "node:path";
import { versionAtLeast } from "./profile-launch-policy.mts";
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

  // Do not honor Workspace-controlled TMPDIR here. This is a Host credential
  // operation and must not discover project settings during initialization.
  const cwd = await fs.mkdtemp("/tmp/consult-auth-");
  const inherited = { ...process.env, ...input.profileLaunch.env };
  const env: NodeJS.ProcessEnv = {
    ...input.profileLaunch.env, PWD: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd,
    NODE_OPTIONS: undefined, NODE_PATH: undefined,
    BASH_ENV: undefined, ENV: undefined, ZDOTDIR: undefined,
  };
  // Credential routing remains Host-owned; relative config paths would change
  // meaning with the private cwd and are rejected instead of reinterpreted.
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) {
    if (inherited[key] && !path.isAbsolute(inherited[key]!)) {
      await fs.rm(cwd, { recursive: true, force: true });
      throw new Error(`Claude Host refresh requires an absolute ${key}`);
    }
  }
  let agent: Awaited<ReturnType<typeof defaultStartAgent>> | undefined;
  let failure: unknown;
  try {
    agent = await (deps.startAgent ?? defaultStartAgent)({
      binary: input.profileLaunch.binary.includes("/")
        ? path.resolve(input.workspaceRoot, input.profileLaunch.binary)
        : input.profileLaunch.binary,
      args: input.profileLaunch.args,
      env,
      cwd,
      workspaceRoot: cwd,
      mode: "read-only",
      sandbox: "off",
      profileRegistryId: "claude",
    });
    const info = agent.capabilities?.agentInfo;
    if (info?.name !== "@agentclientprotocol/claude-agent-acp" || !versionAtLeast(info.version, "0.59.0")) {
      throw new Error("Automatic Claude refresh requires claude-agent-acp 0.59.0 or newer");
    }
    await withTimeout(
      (deps.newSession ?? defaultNewSession)(agent.connection, {
        cwd,
        _meta: { claudeCode: { options: {
          settingSources: [], settings: { disableAllHooks: true },
          strictMcpConfig: true, tools: [], plugins: [], persistSession: false,
        } } },
      }),
      deps.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await agent?.dispose();
    } catch (cleanupError) {
      if (failure === undefined) failure = cleanupError;
      else noteCleanupFailure(failure, cleanupError);
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
  if (failure !== undefined) throw failure;
}

export interface ClaudeRefreshPreflightDeps {
  allowHostRefresh: boolean;
  onRefresh?: () => void;
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
    deps.onRefresh?.();
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
        // Deliberately not unref'd: an unref'd timer only fires while something
        // else holds the event loop open, so the timeout stops being a reliable
        // guard exactly when the refresh has gone quiet. The finally below
        // clears it, so holding the loop costs nothing.
        timeout = setTimeout(
          () => reject(new Error("automatic Claude Host credential refresh timed out")),
          timeoutMs,
        );
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
