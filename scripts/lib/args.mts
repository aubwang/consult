export const BOOLEAN_FLAGS = new Set([
  "read-only",
  "write",
  "background",
  "wait",
  "resume",
  "fresh",
  "include-diff",
  "isolated",
  "allow-fetch",
  "allow-exec",
  "follow",
  "json",
  "summary",
  "all",
  "cleanup",
  "reference",
  "keep-running",
]);

export type FlagValue = string | boolean | (string | boolean)[];

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, FlagValue | undefined>;
}

export function stringFlag(value: unknown): string | undefined {
  const last = Array.isArray(value) ? value.at(-1) : value;
  return typeof last === "string" ? last : undefined;
}

export function boolFlag(value: unknown): boolean {
  const last = Array.isArray(value) ? value.at(-1) : value;
  if (last === true || last === "true") return true;
  if (last === false || last === "false" || last === undefined) return false;
  const error = new Error("boolean flag value must be true or false") as Error & { code: string };
  error.code = "INVALID_BOOLEAN_FLAG";
  throw error;
}

export function invalidBooleanFlagValueError(
  flags: Record<string, FlagValue | undefined> | undefined,
): string | null {
  for (const [name, value] of Object.entries(flags ?? {})) {
    if (!BOOLEAN_FLAGS.has(name)) continue;
    const last = Array.isArray(value) ? value.at(-1) : value;
    if (![true, false, "true", "false"].includes(last as string | boolean)) {
      return `--${name} must be true or false`;
    }
  }
  return null;
}

export function missingFlagValueError(
  flags: Record<string, FlagValue | undefined> | undefined,
  names: string[],
): string | null {
  for (const name of names) {
    const value = flags?.[name];
    const last = Array.isArray(value) ? value.at(-1) : value;
    if (last === true || last === "") {
      return `--${name} requires a value`;
    }
  }
  return null;
}

export function unsupportedFlagError(
  flags: Record<string, FlagValue | undefined> | undefined,
  allowedNames: readonly string[],
): string | null {
  const allowed = new Set(allowedNames);
  const unsupported = Object.keys(flags ?? {}).find(
    (name) => !allowed.has(name) && !ALWAYS_ALLOWED_FLAGS.has(name),
  );
  if (!unsupported) return null;
  const suggestion = closestName(unsupported, allowedNames);
  return suggestion
    ? `--${unsupported} is not supported by this command; did you mean --${suggestion}?`
    : `--${unsupported} is not supported by this command`;
}

// `--help` is answered by the dispatcher before a handler runs, so no command
// needs to repeat it in its allow-list to avoid rejecting it as unsupported.
const ALWAYS_ALLOWED_FLAGS = new Set(["help"]);

// Suggest a near-miss only when the typo is close enough that the guess is more
// likely to help than to mislead.
export function closestName(
  candidate: string,
  names: readonly string[],
  maxDistance = 3,
): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = Math.min(maxDistance, Math.max(1, Math.floor(candidate.length / 2) + 1));
  for (const name of names) {
    const distance = editDistance(candidate, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best !== null && bestDistance <= limit ? best : null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, FlagValue | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex !== -1) {
        addFlag(flags, token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
        continue;
      }
      const name = token.slice(2);
      if (name.startsWith("no-")) {
        addFlag(flags, name.slice(3), false);
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        addFlag(flags, name, true);
        continue;
      }
      const nextToken = argv[index + 1];
      if (nextToken !== undefined && !nextToken.startsWith("--")) {
        addFlag(flags, name, nextToken);
        index += 1;
        continue;
      }
      addFlag(flags, name, "");
      continue;
    }
    positional.push(token);
  }

  return {
    positional,
    flags,
  };
}

function addFlag(
  flags: Record<string, FlagValue | undefined>,
  name: string,
  value: string | boolean,
): void {
  if (flags[name] === undefined) {
    flags[name] = value;
    return;
  }
  if (Array.isArray(flags[name])) {
    flags[name].push(value);
    return;
  }
  flags[name] = [flags[name], value];
}
