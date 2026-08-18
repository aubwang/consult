import fs from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./objects.mts";
import { resolvePackageRoot } from "./companion/version.mts";

// ADR-0042. Execute is denied for every Job, with exactly one carve-out: a Job
// that already holds ambient Host authority may run `consult report` on itself.
// Everything here is deny-by-default. A construct this module does not fully
// understand is not approved, because approving it would mean approving
// whatever it actually does.

export const REPORT_EXEC_SUBCOMMAND = "report";

// --job is deliberately absent. A Job may only report as itself, which
// CONSULT_PARENT_JOB already states; accepting --job would let one Job write
// into another Job's event stream.
const ALLOWED_REPORT_FLAGS = new Set(["--type", "--message", "--data"]);

const SHELL_BASENAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Only the two spellings that mean "run exactly this one script string".
// Anything else (-i, -s, -e, extra options) changes how the script is read.
const SHELL_COMMAND_FLAGS = new Set(["-c", "-lc", "-cl"]);

// rawInput keys that would change what the command actually does. `env` is the
// important one: a delegate that could set CONSULT_PARENT_JOB would be able to
// report as a different Job, which is the whole thing --job is excluded for.
const REJECTED_RAW_INPUT_FIELDS = new Set(
  ["env", "environment", "withEscalatedPermissions", "escalatedPermissions", "sudo"].map(
    normalizeFieldName,
  ),
);

// Characters an unquoted token may contain without being able to change what
// the shell executes. Everything else - including the whole metacharacter set
// & | ; < > ` $ ( ) { } [ ] * ? ~ ! # \ and quotes - denies.
const SAFE_UNQUOTED_CHARACTER = /^[A-Za-z0-9._\-/=:,@+]$/u;

// A command far larger than a bounded report needs is not a report.
const MAX_COMMAND_BYTES = 64 * 1024;

export interface ReportExecDeps {
  /** Realpath of this installation's own `bin/consult`, or null when unknown. */
  consultBinPath: () => Promise<string | null>;
  realpath?: (target: string) => Promise<string>;
  isExecutableFile?: (target: string) => Promise<boolean>;
  pathEnv?: string;
}

export interface ReportExecContext {
  cwd: string;
  deps: ReportExecDeps;
}

export async function isApprovedReportExec(
  rawInput: unknown,
  { cwd, deps }: ReportExecContext,
): Promise<boolean> {
  const argv = reportExecArgv(rawInput);
  if (argv === null) {
    return false;
  }
  return await resolvesToConsult(argv[0], cwd, deps);
}

// Syntax first: the filesystem work only runs for something already shaped like
// `<binary> report [allowed flags] [-- message]`.
export function reportExecArgv(rawInput: unknown): string[] | null {
  if (!isRecord(rawInput)) {
    return null;
  }
  for (const [key, value] of Object.entries(rawInput)) {
    if (REJECTED_RAW_INPUT_FIELDS.has(normalizeFieldName(key)) && isMeaningful(value)) {
      return null;
    }
  }
  const parsed = commandArgv(rawInput.command);
  if (parsed === null) {
    return null;
  }
  const argv = unwrapShell(parsed) ?? parsed;
  if (argv.length === 0 || argv[0] === "" || isShellName(argv[0])) {
    return null;
  }
  return isReportArgv(argv) ? argv : null;
}

// A string command is read by a shell, so it is tokenized under shell rules and
// denied on any construct that could mean more than one invocation. An array is
// the argv itself: its elements are literal arguments that no shell will look
// at again, so a message containing `&&` is just text there.
function commandArgv(command: unknown): string[] | null {
  if (typeof command === "string") {
    return tokenizeCommandString(command);
  }
  if (Array.isArray(command) && command.every((entry) => typeof entry === "string")) {
    return command.length > 0 ? [...(command as string[])] : null;
  }
  return null;
}

export function tokenizeCommandString(command: string): string[] | null {
  if (command.length > MAX_COMMAND_BYTES || /[\n\r\0]/u.test(command)) {
    return null;
  }
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let index = 0;

  const push = (): void => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  while (index < command.length) {
    const character = command[index];
    if (character === " " || character === "\t") {
      push();
      index += 1;
      continue;
    }
    if (character === "'") {
      // Nothing is special inside single quotes, so the run is safe verbatim.
      const end = command.indexOf("'", index + 1);
      if (end === -1) {
        return null;
      }
      current += command.slice(index + 1, end);
      started = true;
      index = end + 1;
      continue;
    }
    if (character === '"') {
      const end = command.indexOf('"', index + 1);
      if (end === -1) {
        return null;
      }
      const inner = command.slice(index + 1, end);
      // A shell still expands $, backticks, and escapes inside double quotes,
      // so the argument we would be approving is not the text we can see.
      if (/[$`\\]/u.test(inner)) {
        return null;
      }
      current += inner;
      started = true;
      index = end + 1;
      continue;
    }
    if (!SAFE_UNQUOTED_CHARACTER.test(character)) {
      return null;
    }
    current += character;
    started = true;
    index += 1;
  }
  push();
  return tokens.length > 0 ? tokens : null;
}

// `bash -lc "<script>"` is how several Profiles run every shell tool call, so
// refusing it outright would refuse the feature. It is unwrapped exactly once,
// only in the three-token form, and only when the script inside is itself one
// simple invocation - which the same tokenizer decides.
function unwrapShell(argv: readonly string[]): string[] | null {
  if (!isShellName(argv[0])) {
    return null;
  }
  if (argv.length !== 3 || !SHELL_COMMAND_FLAGS.has(argv[1])) {
    return null;
  }
  const inner = tokenizeCommandString(argv[2]);
  if (inner === null || inner.length === 0 || isShellName(inner[0])) {
    return null;
  }
  return inner;
}

function isShellName(candidate: string): boolean {
  return SHELL_BASENAMES.has(path.basename(candidate));
}

// Mirrors parseArgs: a following token becomes the flag's value only when it is
// not itself a flag. Without that, `--type --job x` would validate as "--type
// with the value --job" here while consult read `--job x` as a real flag.
export function isReportArgv(argv: readonly string[]): boolean {
  if (argv.length < 2 || argv[1] !== REPORT_EXEC_SUBCOMMAND) {
    return false;
  }
  let index = 2;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      // Everything after -- is the message, which is data.
      return true;
    }
    if (!token.startsWith("--")) {
      return false;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!ALLOWED_REPORT_FLAGS.has(name)) {
      return false;
    }
    index += 1;
    if (equals === -1 && index < argv.length && !argv[index].startsWith("--")) {
      index += 1;
    }
  }
  return true;
}

// Identity, not spelling: the invoked file must realpath to the same entry point
// as the installation supervising this Job. A workspace-local ./consult fails,
// while the symlink an npm global install puts on PATH passes because both sides
// are resolved. A second, different consult installation on PATH also fails -
// this Job's reports belong to this Job's state directory.
async function resolvesToConsult(
  candidate: string,
  cwd: string,
  deps: ReportExecDeps,
): Promise<boolean> {
  const realpath = deps.realpath ?? ((target: string) => fs.realpath(target));
  const expected = await deps.consultBinPath();
  if (!expected) {
    return false;
  }
  const target = candidate.includes("/")
    ? path.resolve(cwd, candidate)
    : await findOnPath(candidate, deps);
  if (target === null) {
    return false;
  }
  try {
    return (await realpath(target)) === expected;
  } catch {
    return false;
  }
}

async function findOnPath(name: string, deps: ReportExecDeps): Promise<string | null> {
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  for (const entry of pathEnv.split(path.delimiter)) {
    if (entry === "") {
      continue;
    }
    const candidate = path.join(entry, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function defaultIsExecutableFile(target: string): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      return false;
    }
    await fs.access(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The identity is this running installation's own entry point, resolved from
// the module doing the checking rather than from anything the Job can influence.
export async function resolveConsultBinPath(
  moduleUrl: string = import.meta.url,
): Promise<string | null> {
  const root = resolvePackageRoot(moduleUrl);
  if (!root) {
    return null;
  }
  try {
    return await fs.realpath(path.join(root, "bin", "consult"));
  } catch {
    return null;
  }
}

function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function normalizeFieldName(key: string): string {
  return key.replaceAll(/[-_]/gu, "").toLowerCase();
}
