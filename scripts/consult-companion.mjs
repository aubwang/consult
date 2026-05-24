import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import * as agents from "./lib/companion/agents.mjs";
import * as brokers from "./lib/companion/brokers.mjs";
import * as cancel from "./lib/companion/cancel.mjs";
import * as delegate from "./lib/companion/delegate.mjs";
import * as result from "./lib/companion/result.mjs";
import * as review from "./lib/companion/review.mjs";
import * as setup from "./lib/companion/setup.mjs";
import * as status from "./lib/companion/status.mjs";
import * as taskResumeCandidate from "./lib/companion/task-resume-candidate.mjs";
import * as taskWorker from "./lib/companion/task-worker.mjs";

const handlers = {
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

const usage = `Usage: consult <subcommand> [args]

Subcommands:
  setup - Configure available profiles and defaults.
  agents - List profiles and update the selected default.
  delegate - Send a prompt turn to a configured profile.
  review - Run a review prompt through a supported profile.
  status - Show job status.
  result - Show stored job output.
  cancel - Cancel a running job.
  brokers - Inspect live Broker state; --cleanup removes stale Brokers.
  task-worker - Run a background job worker.
  task-resume-candidate - Find a resume candidate for a job.`;

export async function dispatch(subcommand, parsedArgs) {
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
