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

const commandUsages: Record<string, string> = {
  agents: agentsUsage,
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
