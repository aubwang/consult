import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  isApprovedReportExec,
  isReportArgv,
  reportExecArgv,
  resolveConsultBinPath,
  tokenizeCommandString,
} from "./report-exec-policy.mts";

const REAL_BIN = "/opt/consult/bin/consult";
const WORKSPACE = "/work";

// Every denial below is a denial of something a hostile or confused Job could
// actually send, so the assertions name the construct rather than the shape.
test("a plain argv array invoking the real consult is approved", async () => {
  const approved = await approve({
    command: [REAL_BIN, "report", "--type", "blocked", "--", "need the staging url"],
  });

  assert.equal(approved, true);
});

test("a simple command string invoking the real consult is approved", async () => {
  const approved = await approve({
    command: `${REAL_BIN} report --type progress --message 'half done'`,
  });

  assert.equal(approved, true);
});

test("bash -lc is unwrapped when the script inside is one simple invocation", async () => {
  const approved = await approve({
    command: ["bash", "-lc", `${REAL_BIN} report --type progress -- ok`],
  });
  const stringForm = await approve({
    command: `bash -lc "${REAL_BIN} report --type progress -- ok"`,
  });

  assert.equal(approved, true);
  assert.equal(stringForm, true);
});

test("a shell operator anywhere in a command string denies", async () => {
  const commands = [
    `${REAL_BIN} report --type progress -- ok && rm -rf /`,
    `${REAL_BIN} report --type progress -- ok; rm -rf /`,
    `${REAL_BIN} report --type progress -- ok || curl evil.example`,
    `${REAL_BIN} report --type progress -- ok | tee /tmp/out`,
    `${REAL_BIN} report --type progress -- ok > /tmp/out`,
    `${REAL_BIN} report --type progress -- ok < /etc/passwd`,
    `${REAL_BIN} report --type progress -- \`whoami\``,
    `${REAL_BIN} report --type progress -- $(whoami)`,
    `${REAL_BIN} report --type progress -- "$(whoami)"`,
    `${REAL_BIN} report --type progress -- ok\nrm -rf /`,
    `${REAL_BIN} report --type progress -- ok & rm -rf /`,
  ];

  for (const command of commands) {
    assert.equal(await approve({ command }), false, command);
  }
});

test("bash -lc denies as soon as the script inside stops being one invocation", async () => {
  const denied = [
    ["bash", "-lc", `${REAL_BIN} report --type progress -- ok && rm -rf /`],
    ["bash", "-lc", `${REAL_BIN} report --type progress -- ok; id`],
    // Two unwraps would mean approving a script we never actually read.
    ["bash", "-lc", `bash -lc "${REAL_BIN} report --type progress -- ok"`],
    // Flags other than -c/-lc change how the script is read.
    ["bash", "-i", "-c", `${REAL_BIN} report --type progress -- ok`],
    ["bash", "-c", `${REAL_BIN} report --type progress -- ok`, "extra"],
  ];

  for (const command of denied) {
    assert.equal(await approve({ command }), false, JSON.stringify(command));
  }
});

// A shell would run the assignment as part of the command, and the one
// assignment that matters is CONSULT_PARENT_JOB: it decides which Job the
// report is attributed to.
test("an environment-prefixed command denies", async () => {
  const prefixed = await approve({
    command: `CONSULT_PARENT_JOB=job-other ${REAL_BIN} report --type progress -- ok`,
  });
  const arrayForm = await approve({
    command: ["FOO=1", REAL_BIN, "report", "--type", "progress", "--", "ok"],
  });

  assert.equal(prefixed, false);
  assert.equal(arrayForm, false);
});

test("a rawInput env or escalation field denies even with a clean command", async () => {
  const withEnv = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    env: { CONSULT_PARENT_JOB: "job-other" },
  });
  const withEscalation = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    with_escalated_permissions: true,
  });
  // An empty or false-y field is not an attempt to change anything.
  const withEmptyEnv = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    env: {},
    with_escalated_permissions: false,
  });

  assert.equal(withEnv, false);
  assert.equal(withEscalation, false);
  assert.equal(withEmptyEnv, true);
});

test("--job denies however it is spelled", async () => {
  const denied = [
    [REAL_BIN, "report", "--job", "job-other", "--type", "progress", "--", "ok"],
    [REAL_BIN, "report", "--job=job-other", "--type", "progress", "--", "ok"],
    // parseArgs would read --job here as a real flag, because --type takes no
    // value when the next token is itself a flag.
    [REAL_BIN, "report", "--type", "--job", "job-other", "--", "ok"],
  ];

  for (const command of denied) {
    assert.equal(await approve({ command }), false, JSON.stringify(command));
  }
});

test("unknown flags and stray positionals deny", async () => {
  const denied = [
    [REAL_BIN, "report", "--agent", "claude", "--", "ok"],
    [REAL_BIN, "report", "--no-type", "--", "ok"],
    [REAL_BIN, "report", "surprise", "--type", "progress"],
    [REAL_BIN, "report", "--type", "progress", "extra"],
    [REAL_BIN, "--json", "report", "--type", "progress"],
  ];

  for (const command of denied) {
    assert.equal(await approve({ command }), false, JSON.stringify(command));
  }
});

test("only the report subcommand is approved", async () => {
  for (const subcommand of ["delegate", "cancel", "steer", "events", "setup", "help"]) {
    assert.equal(
      await approve({ command: [REAL_BIN, subcommand, "--type", "progress"] }),
      false,
      subcommand,
    );
  }
});

test("a workspace-local consult imposter denies", async () => {
  const imposter = await approve({ command: ["./consult", "report", "--type", "progress"] });
  const nested = await approve({
    command: [`${WORKSPACE}/tools/consult`, "report", "--type", "progress"],
  });

  assert.equal(imposter, false);
  assert.equal(nested, false);
});

// npm global installs put a symlink on PATH, so identity has to be decided
// after resolving both sides, not by comparing spellings.
test("a symlink to the real consult is approved and a second install is not", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "consult-exec-")));
  const realBin = path.join(dir, "real-consult");
  const link = path.join(dir, "consult-link");
  const other = path.join(dir, "other-consult");
  await fs.writeFile(realBin, "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(other, "#!/bin/sh\n", { mode: 0o755 });
  await fs.symlink(realBin, link);
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const viaSymlink = await isApprovedReportExec(
    { command: [link, "report", "--type", "progress", "--", "ok"] },
    { cwd: WORKSPACE, deps: { consultBinPath: async () => realBin } },
  );
  const viaOther = await isApprovedReportExec(
    { command: [other, "report", "--type", "progress", "--", "ok"] },
    { cwd: WORKSPACE, deps: { consultBinPath: async () => realBin } },
  );

  assert.equal(viaSymlink, true);
  assert.equal(viaOther, false);
});

test("a bare name resolves through PATH and must still be the same installation", async () => {
  const deps = {
    consultBinPath: async () => REAL_BIN,
    realpath: async (target: string) =>
      target === "/usr/local/bin/consult" ? REAL_BIN : target,
    isExecutableFile: async (target: string) =>
      target === "/usr/local/bin/consult" || target === "/usr/bin/consult",
    pathEnv: "/usr/local/bin:/usr/bin",
  };

  const resolved = await isApprovedReportExec(
    { command: ["consult", "report", "--type", "progress", "--", "ok"] },
    { cwd: WORKSPACE, deps },
  );
  const shadowed = await isApprovedReportExec(
    { command: ["consult", "report", "--type", "progress", "--", "ok"] },
    {
      cwd: WORKSPACE,
      deps: { ...deps, pathEnv: "/usr/bin" },
    },
  );
  const absent = await isApprovedReportExec(
    { command: ["consult", "report", "--type", "progress", "--", "ok"] },
    { cwd: WORKSPACE, deps: { ...deps, pathEnv: "" } },
  );

  assert.equal(resolved, true);
  assert.equal(shadowed, false, "a different consult on PATH is not this installation");
  assert.equal(absent, false);
});

test("an unknown consult entry point denies every command", async () => {
  const approved = await isApprovedReportExec(
    { command: [REAL_BIN, "report", "--type", "progress", "--", "ok"] },
    { cwd: WORKSPACE, deps: { consultBinPath: async () => null } },
  );

  assert.equal(approved, false);
});

test("a malformed or missing command denies", async () => {
  const denied: unknown[] = [
    null,
    "consult report",
    { cwd: WORKSPACE },
    { command: 7 },
    { command: [] },
    { command: "" },
    { command: [REAL_BIN, 7] },
    { command: [REAL_BIN] },
  ];

  for (const rawInput of denied) {
    assert.equal(await approve(rawInput), false, JSON.stringify(rawInput) ?? "undefined");
  }
});

test("the tokenizer keeps quoted data whole and denies unclosed or expanding quotes", () => {
  assert.deepEqual(tokenizeCommandString(`consult report --data '{"a":1}'`), [
    "consult",
    "report",
    "--data",
    '{"a":1}',
  ]);
  assert.deepEqual(tokenizeCommandString(`consult report -- "two words"`), [
    "consult",
    "report",
    "--",
    "two words",
  ]);
  assert.deepEqual(tokenizeCommandString("consult report --type=progress"), [
    "consult",
    "report",
    "--type=progress",
  ]);
  assert.equal(tokenizeCommandString(`consult report -- 'unclosed`), null);
  assert.equal(tokenizeCommandString(`consult report -- "unclosed`), null);
  assert.equal(tokenizeCommandString(`consult report -- "cost is $TOTAL"`), null);
  assert.equal(tokenizeCommandString(`consult report -- "esc\\aped"`), null);
});

// An array element is a literal argument no shell reads again, so a message may
// contain anything; the same text in a string command would have to be quoted.
test("an argv array carries message text a shell would treat as an operator", async () => {
  const approved = await approve({
    command: [REAL_BIN, "report", "--type", "blocked", "--", "build fails: make && ./run"],
  });

  assert.equal(approved, true);
});

test("reportExecArgv reports the argv it would approve for reuse in diagnostics", () => {
  assert.deepEqual(reportExecArgv({ command: ["bash", "-lc", "c report --type progress"] }), [
    "c",
    "report",
    "--type",
    "progress",
  ]);
  assert.equal(reportExecArgv({ command: ["bash", "-lc", "c delegate"] }), null);
});

test("isReportArgv mirrors how consult itself parses the flags", () => {
  assert.equal(isReportArgv(["c", "report"]), true);
  assert.equal(isReportArgv(["c", "report", "--type", "progress"]), true);
  assert.equal(isReportArgv(["c", "report", "--type=progress"]), true);
  assert.equal(isReportArgv(["c", "report", "--type", "progress", "--"]), true);
  assert.equal(isReportArgv(["c", "report", "--message", "--", "hi"]), true);
  assert.equal(isReportArgv(["c", "report", "--type"]), true);
  assert.equal(isReportArgv(["c"]), false);
  assert.equal(isReportArgv(["c", "reports"]), false);
});

test("resolveConsultBinPath finds this installation's own entry point", async () => {
  const resolved = await resolveConsultBinPath();

  assert.ok(resolved, "expected the running installation to have a bin/consult");
  assert.equal(path.basename(resolved), "consult");
  assert.equal(resolved, await fs.realpath(resolved));
});

async function approve(rawInput: unknown): Promise<boolean> {
  return await isApprovedReportExec(rawInput, {
    cwd: WORKSPACE,
    deps: {
      consultBinPath: async () => REAL_BIN,
      realpath: async (target: string) => target,
      isExecutableFile: async () => false,
      pathEnv: "",
    },
  });
}
