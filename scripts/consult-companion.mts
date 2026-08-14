import { pathToFileURL } from "node:url";

import { boolFlag, closestName, invalidBooleanFlagValueError, parseArgs } from "./lib/args.mts";
import type { ParsedArgs } from "./lib/args.mts";
import { commandUsage, helpRequested } from "./lib/companion/command-help.mts";
import { helpFor, helpOverview } from "./lib/companion/help.mts";
import type { CliResult } from "./lib/companion/job-record-errors.mts";
import { resolvePackageVersion } from "./lib/companion/version.mts";

interface CompanionHandler {
  run(subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult>;
}

// Handlers load on demand. Importing all of them eagerly pulled the ACP SDK,
// the sandbox runtime, and zod into every invocation, so commands that never
// launch a Profile (help, status, logs, agents) paid a few hundred milliseconds
// of module loading before printing anything.
const handlers: Record<string, () => Promise<CompanionHandler>> = {
  setup: () => import("./lib/companion/setup.mts"),
  agents: () => import("./lib/companion/agents.mts"),
  delegate: () => import("./lib/companion/delegate.mts"),
  doctor: () => import("./lib/companion/doctor.mts"),
  chain: () => import("./lib/companion/chain.mts"),
  logs: () => import("./lib/companion/logs.mts"),
  review: () => import("./lib/companion/review.mts"),
  status: () => import("./lib/companion/status.mts"),
  result: () => import("./lib/companion/result.mts"),
  cancel: () => import("./lib/companion/cancel.mts"),
  wait: () => import("./lib/companion/wait.mts"),
  brokers: () => import("./lib/companion/brokers.mts"),
  "task-worker": () => import("./lib/companion/task-worker.mts"),
  "task-resume-candidate": () => import("./lib/companion/task-resume-candidate.mts"),
};

// Internal plumbing invoked by Consult itself, not part of the documented
// surface a user is expected to type or have typo'd.
const INTERNAL_COMMANDS = new Set(["task-worker", "task-resume-candidate"]);

export async function dispatch(
  subcommand: string | undefined,
  parsedArgs: ParsedArgs,
): Promise<CliResult> {
  const invalidBoolean = invalidBooleanFlagValueError(parsedArgs?.flags);
  if (invalidBoolean) {
    return { exitCode: 2, stdout: "", stderr: `${invalidBoolean}\n` };
  }
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    // `--reference` used to select a second, agent-facing dump of the whole
    // contract. Progressive disclosure replaced that split, so it now just
    // means "print everything" alongside the current spelling.
    const everything = boolFlag(parsedArgs?.flags?.all) || boolFlag(parsedArgs?.flags?.reference);
    return helpFor(parsedArgs?.positional?.[0], everything);
  }
  if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
    return { exitCode: 0, stdout: `${resolvePackageVersion()}\n`, stderr: "" };
  }
  const loadHandler = handlers[subcommand];
  if (!loadHandler) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: unknownSubcommandError(subcommand),
    };
  }
  // --help never reaches a handler, so a command that would otherwise reject it
  // as an unsupported flag still answers with usage.
  if (helpRequested(parsedArgs?.flags)) {
    return {
      exitCode: 0,
      stdout: commandUsage(subcommand) ?? helpOverview(),
      stderr: "",
    };
  }
  try {
    const handler = await loadHandler();
    return await handler.run(subcommand, parsedArgs);
  } catch (error) {
    if ((error as { code?: string }).code === "NO_WORKSPACE") {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "no workspace found: run consult inside a git repository\n",
      };
    }
    throw error;
  }
}

// A wrong subcommand is usually a typo, so lead with the correction and a
// pointer to help instead of reprinting the whole usage block over the error
// the user needs to read.
export function unknownSubcommandError(subcommand: string): string {
  const known = Object.keys(handlers).filter((name) => !INTERNAL_COMMANDS.has(name));
  const suggestion = closestName(subcommand, known);
  const hint = suggestion ? `did you mean 'consult ${suggestion}'?` : "run 'consult help'";
  return `unknown subcommand: ${subcommand}\n${hint}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sub, ...rest] = process.argv;
  const parsed = parseArgs(rest ?? []);
  const { exitCode, stdout, stderr } = await dispatch(sub ?? "help", parsed);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = exitCode;
}
