// Git runs against the explicit Workspace, never an ambient index/worktree or
// command-scoped config inherited from the Host's own Git invocation.
export function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...overrides,
  };
}

export const GIT_STABLE_CONFIG = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "color.ui=false", "-c", "diff.noprefix=false",
];
