import assert from "node:assert/strict";
import { test } from "node:test";

import { commandUsage, helpRequested } from "./command-help.mts";
import { parseArgs } from "../args.mts";

test("helpRequested recognizes --help however it parses", () => {
  assert.equal(helpRequested(parseArgs(["--help"]).flags), true);
  assert.equal(helpRequested(parseArgs(["--help", "--json"]).flags), true);
  assert.equal(helpRequested(parseArgs(["--set", "claude", "--help"]).flags), true);
  assert.equal(helpRequested(parseArgs(["--json"]).flags), false);
  assert.equal(helpRequested(parseArgs(["--no-help"]).flags), false);
  assert.equal(helpRequested(undefined), false);
});

test("agents usage explains selection order and both default scopes", () => {
  const usage = commandUsage("agents");

  assert.ok(usage);
  assert.match(usage, /consult agents --set <profile> \[--host <host>\]/u);
  assert.match(usage, /Profile selection order:/u);
  assert.match(usage, /1\. Explicit --agent <profile>/u);
  assert.match(usage, /2\. The default recorded for the current Host\./u);
  assert.match(usage, /3\. The global default\./u);
  assert.match(usage, /consult agents --set claude --host codex/u);
  assert.match(usage, /consult doctor --agent claude/u);
});

test("commandUsage returns null for commands without command-specific usage", () => {
  assert.equal(commandUsage("doctor"), null);
  assert.equal(commandUsage("nonsense"), null);
});
