import assert from "node:assert/strict";
import { test } from "node:test";

import { commandUsage, helpRequested } from "./command-help.mts";
import { parseArgs } from "../args.mts";
import { JOB_LABEL_MAX_LENGTH } from "../job-label.mts";

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

test("commandUsage returns null for an unknown command", () => {
  assert.equal(commandUsage("nonsense"), null);
});

// Falling back to the summary usage hides the flags the user actually asked
// about, so every documented command owns command-specific help.
test("every user-facing command has command-specific usage", () => {
  const documented = [
    "setup",
    "agents",
    "delegate",
    "review",
    "doctor",
    "status",
    "wait",
    "logs",
    "result",
    "report",
    "events",
    "chain",
    "cancel",
    "brokers",
  ];

  for (const command of documented) {
    const usage = commandUsage(command);

    assert.ok(usage, `${command} has no command-specific usage`);
    assert.match(usage, new RegExp(`^Usage:\\n {2}consult ${command}\\b`, "u"), command);
    assert.match(usage, /\n {2}--help {2,}/u, `${command} usage does not document --help`);
  }
});

// delegate --wait is an explicit spelling of the default blocking behavior and
// is rejected alongside --background, so the help must not read as a mode that
// blocks on a backgrounded Job.
test("delegate usage describes --wait as the default, not a background mode", () => {
  const usage = commandUsage("delegate");

  assert.ok(usage);
  assert.match(usage, /--wait\s+Block until the turn finishes\./u);
  assert.match(usage, /cannot be\s+combined with --background/u);
  assert.match(usage, /consult wait <job-id>/u);
  assert.doesNotMatch(usage, /backgrounded Job/u);
});

// Overlong labels are rejected, not shortened, so the help must not imply
// truncation.
test("delegate usage does not imply labels are truncated", () => {
  const usage = commandUsage("delegate");

  assert.ok(usage);
  assert.match(usage, new RegExp(`1-${JOB_LABEL_MAX_LENGTH} characters`, "u"));
  assert.match(usage, /rejected\s+rather than shortened/u);
  assert.doesNotMatch(usage, /trimmed to \d+ characters/u);
});
