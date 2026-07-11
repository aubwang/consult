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
  if (Array.isArray(value)) {
    return value.at(-1);
  }
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(value: unknown): boolean {
  const last = Array.isArray(value) ? value.at(-1) : value;
  return last === true || last === "true";
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
  const unsupported = Object.keys(flags ?? {}).find((name) => !allowed.has(name));
  return unsupported ? `--${unsupported} is not supported by this command` : null;
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
      }
      if (flags[name] === undefined) {
        addFlag(flags, name, true);
      }
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
