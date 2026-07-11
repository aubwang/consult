import { pathToFileURL } from "node:url";

import { boolFlag, parseArgs } from "./lib/args.mts";
import type { ParsedArgs } from "./lib/args.mts";
import type { CliResult } from "./lib/companion/job-record-errors.mts";
import * as agents from "./lib/companion/agents.mts";
import * as brokers from "./lib/companion/brokers.mts";
import * as cancel from "./lib/companion/cancel.mts";
import * as chain from "./lib/companion/chain.mts";
import * as delegate from "./lib/companion/delegate.mts";
import * as doctor from "./lib/companion/doctor.mts";
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

const summaryUsage = `Usage:
  consult <command> [options]
  consult help --reference

Delegate focused work from the current Host to a configured Claude, Codex, or
opencode Profile.

Commands:
  setup      Install or verify Profiles.
  agents     List Profiles or set defaults.
  delegate   Send one self-contained prompt turn to a Profile.
  review     Run a pinned, read-only Git review.
  doctor     Check Profile and Job Authority readiness.
  status     List Jobs or inspect one Job.
  logs       Print or follow Job updates.
  result     Print a finished Job result.
  chain      Show a Job's delegation lineage.
  cancel     Cancel an active Job and descendants.
  brokers    Inspect or clean Broker state.
  help       Show concise help.

Examples:
  consult setup
  consult delegate --agent claude --read-only -- "review this design"
  consult delegate --agent codex --write --isolated -- "implement the fix"
  consult status <job-id> --wait
  consult result <job-id>

Delegation defaults to read-only confinement. Use --write --isolated for
transactional edits. Run consult help --reference for all flags, authority
semantics, background/resume behavior, JSON contracts, and exit codes.
`;

const operationalUsage = `Operational contract

## Cold delegation

The Profile does not receive the current Host conversation. Everything after
-- is the prompt (or use --prompt <text>). Include relevant paths, the
concrete question, constraints, and acceptance criteria.

Optional --model and --effort values pass through to the selected Profile.
Omit --model to use that confined Profile runtime's default. Confined launch
does not copy Codex config.toml or Claude settings.json, so pass --model when
Host config controls the desired choice. Family aliases resolve only against
models advertised at Session start. OpenCode exact model ids use provider/model.

## Modes and isolation

- Default or --read-only: inspect only; edits, fetch, and execute are denied.
- --write: permit workspace-confined edits in the current checkout.
- --write --isolated: seed a detached worktree from current staged,
  unstaged, and safe nonignored untracked state. Gitignored files are not
  seeded or captured. The original checkout stays unchanged;
  Job artifacts contain the Profile-only binary patch and touched-files list.
- --sandbox confined (default): launch built-in codex or claude Profiles inside
  Consult-managed native confinement on Linux or native arm64 macOS. Direct
  networking is blocked; model traffic uses an authenticated model-host
  allowlist proxy.
- --allow-fetch: additionally permit arbitrary public TCP/443 through that proxy
  for HTTPS-oriented research; Consult does not inspect the encrypted protocol.
  This is task-specific authority, not a harmless convenience: the Profile also
  holds its selected model credential, so prompt-injected content could send
  readable data to a public host.
- --sandbox inherit: deliberately add no Consult OS boundary and use only the
  trusted Host's ambient authority. Read-only/path checks are then cooperative
  and detective, not OS-preventive. Consult never retries with inheritance
  implicitly.
- --allow-exec: currently fails preflight while execute-specific resource and
  cross-Profile conformance work remains incomplete.
- Confined Jobs have wall-clock and persisted-log limits, but no process-count,
  CPU, memory, disk, or global fan-out quota. The trusted Host must bound
  concurrent delegates.

--write and --read-only are mutually exclusive. --isolated requires --write;
--allow-fetch requires confinement; fetch and execute cannot be combined.
Confined nesting is unsupported: have the trusted root Host create a sibling
Job, or choose inheritance explicitly for a cooperative ambient chain.

Native Windows and macOS x64 processes (including Node under Rosetta) are
unsupported, including inheritance. Confined
authority is currently implemented only for built-in codex and claude Profile
identities on native Linux and native arm64 macOS; custom and opencode Profiles
require explicit --sandbox inherit. Run consult doctor --agent <profile> before
delegation to check the exact Profile
launch in the current Host context. Doctor briefly stages the selected
credential and initializes/disposes the Profile, but sends no model prompt. A
failed preflight creates no Job.

## Pinned diffs and review

delegate --include-diff [--base <ref>] captures a bounded deterministic diff
before Job creation and appends it inside untrusted-data delimiters. --base
requires --include-diff for delegate.

review [--base <ref>] always creates a read-only findings-first Job against
a pinned diff. Codex may use its verified native review command; every other
Profile uses the portable delegate path.

## Foreground and background

- Foreground delegate (default) streams progress and final agent text, then
  prints consult <kind> <job-id> <status>.
- --background writes a queued Job, starts a detached worker, and returns
  immediately. Poll with consult status <job-id> --wait, then use
  consult result <job-id>.
- Each normal background Job has a Job-scoped Broker. An isolated background
  worker may host the same runtime inline so Workspace identity and execution
  cwd remain separate.

## Sessions and lineage

- --resume reopens the most recent completed or failed delegate Session for
  this Host Session, Workspace, and Profile; cancelled Jobs are skipped.
- --resume-job <job-id> selects an explicit compatible prior Job.
- --fresh forces a new Session. The resume selectors are mutually exclusive.
- Resume stays within one Profile; Consult does not convert native sessions
  between agent CLIs.
- Nested delegation passes --parent-job <job-id>, or inherits
  CONSULT_PARENT_JOB. Linked children are policy-checked against the declared
  parent's permission mode and a maximum depth of two. Parent linkage comes
  from child-controlled arguments/environment, so this is cooperative product
  policy rather than an authenticated OS security boundary.

## JSON

Job-bearing JSON uses schema version 1. A single Job is:

    {"schemaVersion":1,"job":{},"outcome":{},"artifacts":{},"lineage":{}}

delegate --json, review --json, and result --json emit that envelope.
status <id> --json adds logTail; status --json and chain --json
return versioned collections of the same Job payload sections. Internal Job
record fields are not a public API. outcome.finalText contains Profile
agent-message text, while tool activity remains in logs. JSON is also available
for setup, agents, logs, doctor, and brokers.

## Host Identity

Resolution order is explicit Host flags, explicit Consult environment values,
known OPENCODE_SESSION_ID / OPENCODE_RUN_ID or CODEX_THREAD_ID, then
terminal/default.

## Exit codes

- 0 success
- 1 internal, agent, or Broker error; doctor also uses 1 when not ready
- 2 usage/configuration error, unknown Job, diff error, or no Git Workspace
- 3 Broker busy, tainted, or Job payload conflict
- 4 status/log follow timeout
- 5 result requested before Job finalization
- 6 delegated turn finalized as failed
- 8 Codex native review command was not advertised by the installed shim
`;

const referenceUsage = `${summaryUsage}\n${operationalUsage}`;

export async function dispatch(
  subcommand: string | undefined,
  parsedArgs: ParsedArgs,
): Promise<CliResult> {
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    return {
      exitCode: 0,
      stdout: boolFlag(parsedArgs?.flags?.reference) ? referenceUsage : summaryUsage,
      stderr: "",
    };
  }
  const handler = handlers[subcommand];
  if (!handler) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `unknown subcommand: ${subcommand}\n\n${summaryUsage}`,
    };
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
