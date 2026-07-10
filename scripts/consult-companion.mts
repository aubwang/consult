import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/args.mts";
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
  consult help
  consult <command> [options]

Consult lets the current Host delegate one self-contained prompt turn to a
configured ACP Profile.

Common workflow:
  consult setup
  consult agents
  consult delegate --agent claude --read-only -- "review this design"
  consult review --agent claude --base main
  consult delegate --agent codex --read-only --include-diff -- "find edge cases"
  consult delegate --agent opencode --write --isolated --sandbox inherit --background -- "add the test"
  consult status <job-id> --wait
  consult result <job-id>
  consult logs <job-id> --follow

Commands:
  setup      Install or verify Profiles and set a default.
             Options: --install <profile>, --set-default <profile>, --json
  agents     List configured Profiles or update defaults.
             Options: --set <profile>, --host <host>, --json
  delegate   Send one prompt turn to a Profile.
             Options: --agent <profile>, --read-only, --write, --isolated,
                      --sandbox <confined|inherit>, --allow-fetch,
                      --allow-exec, --background, --include-diff,
                      --base <ref>, --resume, --resume-job <job-id>, --fresh,
                      --parent-job <job-id>, --model <name>, --effort <level>,
                      --json
             --model accepts an exact id or an advertised family alias:
             Codex sol/terra/luna; Claude sonnet/opus/haiku/fable.
  review     Run a pinned, read-only review through any configured Profile.
             Options: --agent <profile>, --base <ref>,
                      --sandbox <confined|inherit>, --json
  doctor     Diagnose Profile, Host Identity, Job, Broker, and Job Authority.
             Options: --agent <profile>, --profile <profile>, --read-only,
                      --write, --isolated, --sandbox <confined|inherit>,
                      --allow-fetch, --allow-exec, --json
  status     Show all Workspace Jobs or inspect one Job.
             Options: --wait, --follow, --json
  result     Print stored final agent text for a finished Job.
             Options: --json
  logs       Print or follow rendered Job updates.
             Options: --follow, --json (not together)
  chain      Show a Delegation Chain rollup for one Job.
             Options: --json
  cancel     Cancel a queued or running Job and active descendants.
  brokers    Inspect live Broker state.
             Options: --cleanup, --json
  help       Show this help.

Terms:
  Host       Where Consult is invoked: terminal, Codex, opencode, or explicit custom Host.
  Profile    The delegated ACP agent: built-ins are claude, codex, and opencode.
  Job        One prompt turn with durable request, outcome, artifacts, and lineage.
  Broker     A short-lived process connecting one background Job to one Profile.

Read-only is the default. Prefer --write --isolated when delegated work should
edit: Consult returns the Profile-only patch without changing this checkout.
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
  Consult-managed native confinement on Linux or macOS. Direct networking is
  blocked; model traffic uses an authenticated model-host allowlist proxy.
- --allow-fetch: additionally permit arbitrary public TCP/443 through that proxy
  for HTTPS-oriented research; Consult does not inspect the encrypted protocol.
  This is task-specific authority, not a harmless convenience: the Profile also
  holds its selected model credential, so prompt-injected content could send
  readable data to a public host.
- --sandbox inherit: deliberately add no Consult OS boundary and use only the
  trusted Host's ambient authority. Read-only/path checks are then cooperative
  and detective, not OS-preventive. Consult never retries with inheritance implicitly.
- --allow-exec: currently fails preflight while execute-specific resource and
  cross-Profile conformance work remains incomplete.

--write and --read-only are mutually exclusive. --isolated requires --write;
--allow-fetch requires confinement; fetch and execute cannot be combined.
Confined nesting is unsupported: have the trusted root Host create a sibling
Job, or choose inheritance explicitly for a cooperative ambient chain.

Native Windows is unsupported, including inheritance. Confined authority is
currently implemented only for built-in codex and claude Profile identities;
custom and opencode Profiles require explicit --sandbox inherit. Run
consult doctor --agent <profile> before delegation to check the exact Profile
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
  CONSULT_PARENT_JOB. A child cannot exceed its parent's permission mode.

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

const usage = `${summaryUsage}\n${operationalUsage}`;

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
