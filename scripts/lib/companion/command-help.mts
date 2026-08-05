import type { FlagValue } from "../args.mts";

const agentsUsage = `Usage:
  consult agents [--json]
  consult agents --set <profile> [--host <host>]

List configured Profiles or set the Profile Consult delegates to by default.

Options:
  --set <profile>  Record <profile> as a default. With --host it applies to
                   that Host only; without --host it becomes the global
                   default.
  --host <host>    Host identity a --set default applies to, for example
                   codex, opencode, claude, or terminal.
  --json           Print the Profile list as JSON instead of a table.
  --help           Print this help instead of listing Profiles.

Profile selection order:
  1. Explicit --agent <profile> (alias --profile) on the command itself.
  2. The default recorded for the current Host.
  3. The global default.

Commands that need a Profile fail with "No profile selected. Available
profiles: ..." when none of those resolve. Set a default or pass --agent.

Examples:
  consult agents                            # Profiles, defaults, and hosts
  consult agents --set claude --host codex  # default for the codex Host
  consult agents --set claude               # global default
  consult delegate --read-only -- "..."     # uses the selected default
  consult doctor                            # diagnose the current selection
  consult doctor --agent claude             # diagnose one Profile
`;

const setupUsage = `Usage:
  consult setup [--json]
  consult setup --install <profile>
  consult setup --set-default <profile>

Install or verify the Profiles Consult can delegate to. With no options it
prints the registry table with each Profile's install and configuration state.

Options:
  --install <profile>      Install the named registry Profile.
  --set-default <profile>  Record an already-configured Profile as the global
                           default. Use consult agents --set for a per-Host
                           default.
  --json                   Print registry status and Profiles as JSON.
  --help                   Print this help instead of running setup.

Examples:
  consult setup                      # what is installed and configured
  consult setup --install codex
  consult setup --set-default claude
  consult doctor --agent codex       # verify the Profile actually launches
`;

const delegateUsage = `Usage:
  consult delegate [options] -- <prompt>
  consult delegate [options] --prompt <text>

Send one self-contained prompt turn to a Profile. The Profile does not receive
the current Host conversation, so the prompt must carry the paths, question,
constraints, and acceptance criteria on its own.

Profile and model:
  --agent <profile>   Profile to delegate to (alias --profile). Defaults to the
                      Host default, then the global default.
  --model <model>     Model passed through to the Profile. Confined launches do
                      not read Host agent config, so pass this when Host config
                      would otherwise choose the model.
  --effort <level>    Reasoning effort passed through to the Profile.
  --label <text>      Non-unique human metadata. Surrounding whitespace is
                      trimmed; the result must be 1-80 characters with no
                      control characters, and a longer label is rejected
                      rather than shortened.

Authority (default is read-only):
  --read-only         Inspect only; edits, fetch, and execute are denied.
  --write             Permit workspace-confined edits in the current checkout.
  --isolated          With --write, run in a detached seeded worktree and return
                      a patch instead of touching the checkout. Requires --write.
  --sandbox <mode>    confined (default) or inherit. inherit adds no Consult OS
                      boundary and hands over ambient Host authority.
  --allow-fetch       Additionally permit public TCP/443 through the proxy. This
                      is task-specific authority, not a convenience: the Profile
                      also holds the model credential.
  --allow-exec        Reserved; currently fails preflight.

Background and dependencies:
  --background        Queue the Job, start a detached worker, and return now.
  --wait              Block until the turn finishes. Delegate already blocks by
                      default, so this only states that explicitly and cannot be
                      combined with --background. To queue a Job and block on it
                      later, use --background and then consult wait <job-id>.
  --after <job-id>    Repeatable prerequisite; requires --background. A failed,
                      cancelled, or skipped prerequisite skips this Job.

Sessions:
  --resume            Reopen the most recent compatible Session for this Host
                      Session, Workspace, and Profile.
  --resume-job <id>   Reopen an explicit compatible prior Job.
  --fresh             Force a new Session. The three are mutually exclusive.

Context and output:
  --include-diff      Append a bounded pinned diff inside untrusted delimiters.
  --base <ref>        Diff base; requires --include-diff.
  --json              Emit the schema-version-1 Job envelope.
  --help              Print this help instead of delegating.

Examples:
  consult delegate --read-only -- "review src/server.ts for races"
  consult delegate --agent codex --write --isolated -- "implement the fix"
  consult delegate --read-only --include-diff --base main -- "review this branch"
  consult delegate --background --label "api audit" -- "audit the API surface"

--write and --read-only are mutually exclusive. Run consult help --reference for
full authority, isolation, and JSON semantics.
`;

const reviewUsage = `Usage:
  consult review [--base <ref>] [options]
  consult review --job <job-id> [options]

Run a pinned, read-only, findings-first Git review. Always creates a read-only
Job; --base and --job are mutually exclusive.

Options:
  --base <ref>       Review the pinned diff against <ref>.
  --job <job-id>     Review a completed isolated write Job using its task, final
                     report, touched-files list, and Consult-owned patch.
  --agent <profile>  Profile to review with (alias --profile). Codex may use its
                     verified native review command; others use the portable
                     delegate path.
  --model <model>    Model passed through to the Profile.
  --effort <level>   Reasoning effort passed through to the Profile.
  --label <text>     Non-unique human metadata for the review Job.
  --sandbox <mode>   confined (default) or inherit.
  --json             Emit the schema-version-1 Job envelope.
  --help             Print this help instead of reviewing.

Examples:
  consult review --base main
  consult review --agent claude --job job-01H...
`;

const doctorUsage = `Usage:
  consult doctor [--agent <profile>] [options]

Check whether the selected Profile can actually launch and be granted the
requested Job Authority in the current Host context. Doctor briefly stages the
credential and initializes/disposes the Profile but sends no model prompt, and
a failed preflight creates no Job.

Options:
  --agent <profile>  Profile to diagnose (alias --profile). Defaults to the
                     current selection.
  --read-only        Diagnose read-only authority (default).
  --write            Diagnose write authority.
  --isolated         Diagnose isolated write authority.
  --sandbox <mode>   confined (default) or inherit.
  --allow-fetch      Include fetch authority in the check.
  --allow-exec       Include execute authority in the check.
  --json             Print the readiness report as JSON.
  --help             Print this help instead of running checks.

Exit codes:
  0 ready, 1 not ready, 2 usage or configuration error.

Examples:
  consult doctor
  consult doctor --agent claude
  consult doctor --agent codex --write --isolated
`;

const statusUsage = `Usage:
  consult status [--all] [--json]
  consult status <job-id> [--wait] [--json]
  consult status <job-id> --follow [--tail <n>]

List Jobs or inspect one Job. With no job id it prints the newest 20 Jobs.
Inspecting one Job prints a concise summary without embedding logs.

Options:
  --all           List the full Job history instead of the newest 20.
  --wait          Block until the selected Job reaches a final status.
  --follow        Stream Job updates; equivalent to consult logs --follow.
  --tail <n>      Bounded window size when following.
  --json          Emit the schema-version-1 Job payload.
  --help          Print this help instead of listing Jobs.

Exit codes:
  0 success, 2 unknown Job or no Git Workspace, 4 --wait timed out.

Examples:
  consult status
  consult status --all
  consult status <job-id> --wait
  consult status <job-id> --json
`;

const waitUsage = `Usage:
  consult wait <job-id> [<job-id>...] [--summary | --json]

Block once for one or more Jobs and return their Results in submission order.

Options:
  --summary        One bounded line per Job with its label, transport status,
                   result or error preview, and artifact paths. Use consult
                   result for a selected full answer.
  --json           Emit the selected terminal Jobs as JSON. Exclusive with
                   --summary.
  --keep-running   Stop waiting on SIGINT/SIGTERM without cancelling. By default
                   an interrupt best-effort cancels the still-active selected
                   Jobs and their linked descendants.
  --help           Print this help instead of waiting.

Exit codes:
  0 success, 2 unknown Job, 4 timed out, 130 SIGINT, 143 SIGTERM.

Examples:
  consult wait <job-id>
  consult wait --summary <job-id> <job-id>
`;

const logsUsage = `Usage:
  consult logs <job-id> [--tail <n> | --all] [--json]
  consult logs <job-id> --follow [--tail <n>]

Print or follow one Job's rendered updates. Prints the latest 20 lines by
default.

Options:
  --tail <n>   Print a different bounded window. Mutually exclusive with --all.
  --all        Print the full history.
  --follow     Seed the bounded window, then stream new updates. Not supported
               with --json.
  --json       Emit raw log entries as JSON.
  --help       Print this help instead of printing logs.

Examples:
  consult logs <job-id>
  consult logs <job-id> --tail 100
  consult logs <job-id> --follow
`;

const resultUsage = `Usage:
  consult result <job-id> [--json]

Print a finished Job's result. outcome.finalText holds the Profile's agent
message text; tool activity stays in consult logs.

Options:
  --json   Emit the schema-version-1 Job envelope.
  --help   Print this help instead of printing a result.

Exit codes:
  0 success, 2 unknown Job, 5 the Job has not finalized yet.

Examples:
  consult result <job-id>
  consult result <job-id> --json
`;

const chainUsage = `Usage:
  consult chain <job-id> [--json]

Show a Job's delegation lineage: its ancestors, descendants, and a rollup of the
chain's status.

Options:
  --json   Emit a versioned collection of the same Job payload sections.
  --help   Print this help instead of printing lineage.

Examples:
  consult chain <job-id>
  consult chain <job-id> --json
`;

const cancelUsage = `Usage:
  consult cancel <job-id>

Cancel one active Job and its linked descendants. Cancellation is best effort:
it signals the Job's Broker and process tree and finalizes the records.

Options:
  --help   Print this help instead of cancelling.

Examples:
  consult cancel <job-id>
`;

const brokersUsage = `Usage:
  consult brokers [--json]
  consult brokers [<job-id>] --cleanup [--json]

Inspect or clean Job-scoped Broker state. With no options it lists known
Brokers and whether each is running, stale, or malformed.

Options:
  --cleanup   Remove stale and malformed Broker state. With a job id it also
              tears down that Job's running Broker.
  --json      Print Broker rows, or the cleanup outcome, as JSON.
  --help      Print this help instead of inspecting Brokers.

Examples:
  consult brokers
  consult brokers --cleanup
  consult brokers <job-id> --cleanup
`;

const commandUsages: Record<string, string> = {
  agents: agentsUsage,
  brokers: brokersUsage,
  cancel: cancelUsage,
  chain: chainUsage,
  delegate: delegateUsage,
  doctor: doctorUsage,
  logs: logsUsage,
  result: resultUsage,
  review: reviewUsage,
  setup: setupUsage,
  status: statusUsage,
  wait: waitUsage,
};

export function helpRequested(flags: Record<string, FlagValue | undefined> | undefined): boolean {
  const value = flags?.help;
  if (value === undefined) return false;
  const last = Array.isArray(value) ? value.at(-1) : value;
  return last !== false && last !== "false";
}

export function commandUsage(subcommand: string): string | null {
  return commandUsages[subcommand] ?? null;
}
