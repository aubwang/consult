import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mts";
import type { ParsedArgs } from "./lib/args.mts";
import type { CliResult } from "./lib/companion/job-record-errors.mts";
import * as agents from "./lib/companion/agents.mts";
import * as brokers from "./lib/companion/brokers.mts";
import * as cancel from "./lib/companion/cancel.mts";
import * as delegate from "./lib/companion/delegate.mts";
import * as result from "./lib/companion/result.mts";
import * as review from "./lib/companion/review.mts";
import * as setup from "./lib/companion/setup.mts";
import * as status from "./lib/companion/status.mts";
import * as taskResumeCandidate from "./lib/companion/task-resume-candidate.mts";
import * as taskWorker from "./lib/companion/task-worker.mts";

interface CompanionHandler {
  run(subcommand: string, parsedArgs: ParsedArgs): Promise<CliResult>;
}

const handlers: Record<string, CompanionHandler> = {
  setup,
  agents,
  delegate,
  review,
  status,
  result,
  cancel,
  brokers,
  "task-worker": taskWorker,
  "task-resume-candidate": taskResumeCandidate,
};

const usage = `Usage:
  consult help
  consult <command> [options]

Consult lets the current Host delegate work to another configured Profile.

Common workflow:
  consult setup
  consult agents
  consult delegate --agent claude --read-only -- "review this diff for bugs"
  consult delegate --agent codex --write --background -- "add a regression test"
  consult delegate --agent gemini --read-only -- "look for missed edge cases"
  consult status <job-id> --wait
  consult result <job-id>

Commands:
  setup      Install or verify Profiles and set a default.
             Options: --install <profile>, --set-default <profile>, --json
  agents     List configured Profiles or update defaults.
             Options: --set <profile>, --host <host>, --json
  delegate   Send a prompt turn to a Profile.
             Options: --agent <profile>, --read-only, --write, --background,
                      --resume, --resume-job <job-id>, --fresh, --model <name>,
                      --effort <level>, --json
  review     Run the built-in review flow through a supported Profile.
             Options: --agent <profile>, --base <ref>
  status     Show Jobs in this workspace, or inspect one Job.
             Options: --wait, --json
  result     Print stored output for a finished Job.
             Options: --json
  cancel     Cancel a running Job and active descendants.
  brokers    Inspect live Broker state.
             Options: --cleanup, --json
  help       Show this help.

Terms:
  Host       Where you run Consult, such as a terminal, Codex, opencode, or Claude Code.
  Profile    The agent Consult calls, such as claude, codex, opencode, gemini, or copilot.
  Job        One delegated prompt turn with status and stored output.
  Broker     The short-lived process that connects one Job to one Profile.

Run delegated work in read-only mode unless you explicitly need edits. Use --write
when the Profile should be allowed to change files in the current workspace.
`;

export async function dispatch(
  subcommand: string | undefined,
  parsedArgs: ParsedArgs,
): Promise<CliResult> {
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    return { exitCode: 0, stdout: usage, stderr: "" };
  }
  const handler = handlers[subcommand];
  if (!handler) {
    return { exitCode: 2, stdout: "", stderr: `unknown subcommand: ${subcommand}\n\n${usage}` };
  }
  return handler.run(subcommand, parsedArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sub, ...rest] = process.argv;
  const parsed = parseArgs(rest ?? []);
  const { exitCode, stdout, stderr } = await dispatch(sub ?? "help", parsed);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}
