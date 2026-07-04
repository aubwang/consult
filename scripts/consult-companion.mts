import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mts";
import type { ParsedArgs } from "./lib/args.mts";
import type { CliResult } from "./lib/companion/job-record-errors.mts";
import * as agents from "./lib/companion/agents.mts";
import * as brokers from "./lib/companion/brokers.mts";
import * as cancel from "./lib/companion/cancel.mts";
import * as delegate from "./lib/companion/delegate.mts";
import * as doctor from "./lib/companion/doctor.mts";
import * as chain from "./lib/companion/chain.mts";
import * as logs from "./lib/companion/logs.mts";
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
  doctor,
  chain,
  logs,
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
  consult logs <job-id> --follow

Commands:
  setup      Install or verify Profiles and set a default.
             Options: --install <profile>, --set-default <profile>, --json
  agents     List configured Profiles or update defaults.
             Options: --set <profile>, --host <host>, --json
  delegate   Send a prompt turn to a Profile.
             Options: --agent <profile>, --read-only, --write, --background,
                      --resume, --resume-job <job-id>, --fresh, --model <name>,
                      --effort <level>, --json
             --model accepts an exact model id or a family alias (for the
             claude Profile: sonnet, opus, haiku, fable); a family alias
             resolves to the newest model the Profile advertises.
  doctor     Diagnose whether Consult can delegate from this workspace.
             Options: --agent <profile>, --profile <profile>, --json
  review     Run the built-in review flow through a supported Profile.
             Options: --agent <profile>, --base <ref>
  status     Show Jobs in this workspace, or inspect one Job.
             Options: --wait, --follow, --json
  result     Print stored output for a finished Job.
             Options: --json
  logs       Print or follow rendered logs for one Job.
             Options: --follow, --json
  chain      Show a Delegation Chain rollup for one Job.
             Options: --json
  cancel     Cancel a running Job and active descendants.
  brokers    Inspect live Broker state.
             Options: --cleanup, --json
  help       Show this help.
             Options: --agent (print the agent-facing usage contract)

Terms:
  Host       Where you run Consult, such as a terminal, Codex, opencode, or Claude Code.
  Profile    The agent Consult calls, such as claude, codex, opencode, gemini, or copilot.
  Job        One delegated prompt turn with status and stored output.
  Broker     The short-lived process that connects one Job to one Profile.

Run delegated work in read-only mode unless you explicitly need edits. Use --write
when the Profile should be allowed to change files in the current workspace.

Agents: run 'consult help --agent' for the full delegation contract
(prompt guidance, JSON output, exit codes, polling and resume semantics).
`;

const agentUsage = `# Consult: Agent Usage Contract

Consult delegates one prompt turn to another locally configured agent CLI (a
Profile) and stores the output as a Job in the current Workspace. This is the
agent-facing contract; \`consult help\` has the short human summary.

## When to use

- Get an independent review or second opinion from a different agent or model.
- Run a self-contained side task (review a diff, hunt edge cases, draft tests)
  without spending your own context on it.
- Continue a prior delegated session with follow-up questions (\`--resume\`).

When not to use: work that needs your conversation context (the delegate never
sees it), or interactive back-and-forth (a Job is exactly one prompt turn).

## Core workflow

    consult agents --json                  # discover configured Profiles
    consult delegate --agent <profile> --read-only -- "<self-contained prompt>"
    consult status <job-id> --wait         # block until the Job finalizes
    consult result <job-id>                # print the stored final text
    consult logs <job-id> --follow         # stream rendered Job updates

## Writing the prompt

- Everything after \`--\` is the prompt (or use \`--prompt <text>\`).
- The delegate starts cold with no access to your conversation. Include file
  paths, the concrete question, and acceptance criteria in the prompt itself.
- Optional pass-through tuning: \`--model <name>\`, \`--effort <level>\`.
  \`--model\` takes an exact model id or a family alias (claude Profile:
  \`sonnet\`, \`opus\`, \`haiku\`, \`fable\`); a family alias resolves to the
  newest model the Profile advertises at session start.

## Modes

- Default is read-only: the delegate cannot edit files. Pass \`--write\` only
  when the task explicitly requires edits to this Workspace.
- \`--write\` and \`--read-only\` are mutually exclusive.

## Foreground vs background

- Foreground (default): streams delegate activity, then prints a summary line
  \`consult delegate <job-id> <status>\`. With \`--json\` the final stdout line
  is one JSON object:
  {"status","jobId","sessionId","stopReason","finalTextLength","logPath"}.
- Background: \`--background\` returns immediately after printing
  \`consult delegate <job-id> queued\` plus a \`consult status <job-id>\` hint
  (with \`--json\`: one JSON object {"status","jobId"}). Poll
  \`consult status <job-id> --wait\` (blocks until the Job finalizes,
  30-minute cap), then read \`consult result <job-id>\`.
- Each running Job has its own Broker; background Jobs run independently.
- \`--background\` and \`--wait\` are mutually exclusive.

## Sessions and resume

- \`--resume\` continues the most recent completed or failed Job for that
  Profile in this Host session (cancelled Jobs are skipped); exits 2 with
  guidance if none exists.
- \`--resume-job <job-id>\` continues a specific Job's session.
- \`--fresh\` forces a new session. The three flags are mutually exclusive.
- Host identity is autodetected (Codex, opencode, and Claude Code session
  variables; override with \`--host\` or \`CONSULT_HOST\`). Resume scoping
  follows the Host session.

## Jobs

- Lifecycle: queued -> running -> completed | cancelled | failed.
- \`consult status\` lists all Jobs in the Workspace (tab-separated table, or
  a JSON array with \`--json\`).
- \`consult status <job-id>\` prints the Job record plus the last 20 log lines
  (with \`--json\`: {"record": ..., "logTail": [...]}).
- \`consult status <job-id> --follow\` and \`consult logs <job-id> --follow\`
  stream rendered Job updates until the Job finalizes.
- \`consult result <job-id>\` prints the delegate's final text verbatim; with
  \`--json\` it prints the full Job record instead.
- \`consult chain <job-id>\` prints the explicit Delegation Chain rollup for
  the Job.
- \`consult doctor\` reports profile, Host Identity, Job, Broker, and sandbox
  readiness for the current Workspace.
- \`consult cancel <job-id>\` cancels a queued or running Job and its active
  descendants.

## Delegation lineage

- When delegating from inside a delegated Job, pass \`--parent-job <job-id>\`
  so the new Job joins the Delegation Chain.
- If the flag is absent, delegate falls back to the \`CONSULT_PARENT_JOB\`
  environment variable (injected into delegated agent environments), so
  nested delegations stay chained by default. An explicit flag wins.

## Exit codes

- 0 success
- 1 internal or Broker error; \`doctor\` also exits 1 when the workspace is
  not delegate-ready (canDelegate false)
- 2 usage error, unknown subcommand, unknown Job id, or not inside a git
  repository (no Workspace)
- 3 Broker busy or Job conflict (inspect with \`consult brokers\`, retry)
- 4 \`status --wait\` or \`--follow\` timed out before the Job finalized
- 5 \`result\` called on an unfinished Job (poll status first)
- 6 the delegated turn finalized as failed (inspect with
  \`consult result <job-id>\`)
- 7 \`review\` is not supported by the selected Profile (codex-only in v1)
- 8 the Profile did not advertise the review command (codex-acp version may
  not support it)

## Parsing guidance

- Prefer \`--json\` wherever you parse output: agents, setup, delegate,
  status, result, logs, chain, doctor, brokers.
- Capture the Job id from delegate stdout in both modes.
`;

export async function dispatch(
  subcommand: string | undefined,
  parsedArgs: ParsedArgs,
): Promise<CliResult> {
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    if (parsedArgs?.flags?.agent !== undefined) {
      return { exitCode: 0, stdout: agentUsage, stderr: "" };
    }
    return { exitCode: 0, stdout: usage, stderr: "" };
  }
  const handler = handlers[subcommand];
  if (!handler) {
    return { exitCode: 2, stdout: "", stderr: `unknown subcommand: ${subcommand}\n\n${usage}` };
  }
  try {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sub, ...rest] = process.argv;
  const parsed = parseArgs(rest ?? []);
  const { exitCode, stdout, stderr } = await dispatch(sub ?? "help", parsed);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}
