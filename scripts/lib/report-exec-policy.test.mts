import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  commandTokens,
  isApprovedReportExec,
  isReportArgv,
  resolveConsultBinPath,
  tokenizeCommandString,
} from "./report-exec-policy.mts";

const REAL_BIN = "/opt/consult/bin/consult";
// The wrapper's trust anchor is a real path so the Workspace-containment check
// resolves against a real filesystem, as it does in production.
const SYSTEM_BASH = "/bin/bash";
const PATH_BASH = "/usr/bin/bash";
const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "consult-exec-ws-")));

after(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

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

test("a rawInput env or sudo field denies even with a clean command", async () => {
  const withEnv = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    env: { CONSULT_PARENT_JOB: "job-other" },
  });
  const withSudo = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    sudo: true,
  });
  // An empty or false-y field is not an attempt to change anything.
  const withEmptyEnv = await approve({
    command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
    env: {},
    sudo: false,
  });

  assert.equal(withEnv, false);
  assert.equal(withSudo, false);
  assert.equal(withEmptyEnv, true);
});

// Codex's read-only agent mode blocks the report's own log append and retries
// with escalation, so refusing it made the carve-out useless for the Profile
// most likely to reach for it. Escalation changes where an already-pinned
// command runs, not what runs.
test("an escalated request is approved when everything else validates", async () => {
  const spellings = [
    "with_escalated_permissions",
    "withEscalatedPermissions",
    "escalated_permissions",
    "escalatedPermissions",
  ];

  for (const field of spellings) {
    assert.equal(
      await approve({
        command: `${REAL_BIN} report --type blocked --message "need guidance: A or B?"`,
        cwd: WORKSPACE,
        [field]: true,
        justification: "the report could not write its log",
      }),
      true,
      field,
    );
  }
});

// The exact shape a live Codex Job sent: the string form, a bare `consult` off
// PATH, `cwd` rather than `workdir`, and a double-quoted message carrying
// punctuation that is not safe unquoted.
test("the shape a live Codex Job sends is approved, escalated or not", async () => {
  const deps = hostDeps({
    realpath: async (target: string) =>
      target === "/usr/local/bin/consult" ? REAL_BIN : target,
    isExecutableFile: async (target: string) => target === "/usr/local/bin/consult",
    pathEnv: "/usr/local/bin",
  });
  const rawInput = {
    command: 'consult report --type blocked --message "need guidance: A or B?"',
    cwd: WORKSPACE,
  };

  assert.equal(await approve(rawInput, deps), true);
  assert.equal(await approve({ ...rawInput, with_escalated_permissions: true }, deps), true);
});

// Escalation rides on the rest of the predicate; it never substitutes for it.
test("escalation does not rescue a request that fails any other check", async () => {
  const escalated = (rawInput: Record<string, unknown>) =>
    approve({ with_escalated_permissions: true, ...rawInput });

  // Attribution is what the env denial protects, and escalation does not touch it.
  assert.equal(
    await escalated({
      command: [REAL_BIN, "report", "--type", "progress", "--", "ok"],
      env: { CONSULT_PARENT_JOB: "job-other" },
    }),
    false,
    "env forging stays denied under escalation",
  );
  assert.equal(
    await escalated({ command: [REAL_BIN, "delegate", "--", "do it"] }),
    false,
    "a non-report subcommand stays denied",
  );
  assert.equal(
    await escalated({
      command: [REAL_BIN, "report", "--job", "job-other", "--type", "progress"],
    }),
    false,
    "--job stays denied",
  );
  assert.equal(
    await escalated({
      command: ["./bash", "-lc", `${REAL_BIN} report --type progress -- ok`],
    }),
    false,
    "a wrapper imposter stays denied",
  );
  assert.equal(
    await escalated({ command: ["./consult", "report", "--type", "progress"] }),
    false,
    "a binary imposter stays denied",
  );
  assert.equal(
    await escalated({
      command: `${REAL_BIN} report --type progress -- ok && rm -rf /`,
    }),
    false,
    "a chained command stays denied",
  );
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

// The wrapper is a program that actually runs, so trusting it by basename
// approved whatever ./bash happened to be while the argv check only ever looked
// at the consult invocation inside it.
test("a workspace-local bash imposter denies however it is spelled", async () => {
  const denied = [
    ["./bash", "-lc", `${REAL_BIN} report --type progress -- ok`],
    [`${WORKSPACE}/bash`, "-lc", `${REAL_BIN} report --type progress -- ok`],
    [`${WORKSPACE}/tools/bash`, "-lc", `${REAL_BIN} report --type progress -- ok`],
  ];

  for (const command of denied) {
    assert.equal(await approve({ command }), false, JSON.stringify(command));
  }
  // The string form goes through the same check.
  assert.equal(
    await approve({ command: `./bash -lc "${REAL_BIN} report --type progress -- ok"` }),
    false,
  );
});

test("an absolute path to the canonical system bash is approved", async () => {
  const approved = await approve({
    command: [SYSTEM_BASH, "-lc", `${REAL_BIN} report --type progress -- ok`],
  });
  const impostorAbsolute = await approve({
    command: ["/opt/evil/bash", "-lc", `${REAL_BIN} report --type progress -- ok`],
  });

  assert.equal(approved, true);
  assert.equal(impostorAbsolute, false);
});

// A PATH the delegate can influence must not be able to nominate the anchor.
test("a bash reached through a Workspace PATH entry denies", async (t) => {
  const bin = path.join(WORKSPACE, "poisoned-bin");
  const planted = path.join(bin, "bash");
  await fsp.mkdir(bin, { recursive: true });
  await fsp.writeFile(planted, "#!/bin/sh\n", { mode: 0o755 });
  t.after(async () => {
    await fsp.rm(bin, { recursive: true, force: true });
  });
  const deps = hostDeps({
    realpath: async (target: string) => target,
    isExecutableFile: async (target: string) => target === planted,
    pathEnv: bin,
  });

  const bare = await approve(
    { command: ["bash", "-lc", `${REAL_BIN} report --type progress -- ok`] },
    deps,
  );
  const absolute = await approve(
    { command: [planted, "-lc", `${REAL_BIN} report --type progress -- ok`] },
    deps,
  );

  assert.equal(bare, false, "the anchor itself must not live inside the Workspace");
  assert.equal(absolute, false);
});

test("a wrapper that cannot be resolved denies", async () => {
  const command = ["bash", "-lc", `${REAL_BIN} report --type progress -- ok`];
  const noBashOnPath = await approve({ command }, hostDeps({ pathEnv: "" }));
  const unresolvable = await approve(
    { command },
    hostDeps({
      realpath: async (target: string) => {
        if (target === PATH_BASH) throw new Error("ENOENT");
        return target;
      },
    }),
  );

  assert.equal(noBashOnPath, false);
  assert.equal(unresolvable, false);
});

// Widening the wrapper allowlist would mean verifying more binaries, so this
// fix recognizes bash only; every other shell keeps denying as a leading name.
test("shells other than bash are not unwrapped", async () => {
  for (const shell of ["sh", "zsh", "dash", "ksh", "/bin/sh"]) {
    assert.equal(
      await approve({ command: [shell, "-lc", `${REAL_BIN} report --type progress -- ok`] }),
      false,
      shell,
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
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "consult-exec-")));
  const realBin = path.join(dir, "real-consult");
  const link = path.join(dir, "consult-link");
  const other = path.join(dir, "other-consult");
  await fsp.writeFile(realBin, "#!/bin/sh\n", { mode: 0o755 });
  await fsp.writeFile(other, "#!/bin/sh\n", { mode: 0o755 });
  await fsp.symlink(realBin, link);
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const viaSymlink = await approve(
    { command: [link, "report", "--type", "progress", "--", "ok"] },
    hostDeps({ consultBinPath: async () => realBin, realpath: undefined }),
  );
  const viaOther = await approve(
    { command: [other, "report", "--type", "progress", "--", "ok"] },
    hostDeps({ consultBinPath: async () => realBin, realpath: undefined }),
  );

  assert.equal(viaSymlink, true);
  assert.equal(viaOther, false);
});

test("a bare name resolves through PATH and must still be the same installation", async () => {
  const deps = hostDeps({
    realpath: async (target: string) =>
      target === "/usr/local/bin/consult" ? REAL_BIN : target,
    isExecutableFile: async (target: string) =>
      target === "/usr/local/bin/consult" || target === "/usr/bin/consult",
    pathEnv: "/usr/local/bin:/usr/bin",
  });
  const command = { command: ["consult", "report", "--type", "progress", "--", "ok"] };

  const resolved = await approve(command, deps);
  const shadowed = await approve(command, { ...deps, pathEnv: "/usr/bin" });
  const absent = await approve(command, { ...deps, pathEnv: "" });

  assert.equal(resolved, true);
  assert.equal(shadowed, false, "a different consult on PATH is not this installation");
  assert.equal(absent, false);
});

test("an unknown consult entry point denies every command", async () => {
  const approved = await approve(
    { command: [REAL_BIN, "report", "--type", "progress", "--", "ok"] },
    hostDeps({ consultBinPath: async () => null }),
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

test("commandTokens gates rawInput and returns the pre-unwrap tokens", () => {
  assert.deepEqual(commandTokens({ command: ["bash", "-lc", "c report"] }), [
    "bash",
    "-lc",
    "c report",
  ]);
  assert.deepEqual(commandTokens({ command: "c report --type progress" }), [
    "c",
    "report",
    "--type",
    "progress",
  ]);
  assert.equal(commandTokens({ command: ["c"], env: { A: "1" } }), null);
  assert.equal(commandTokens("c report"), null);
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
  assert.equal(resolved, await fsp.realpath(resolved));
});

// Models the ordinary host: bash is on PATH at /usr/bin/bash, symlinked to the
// system /bin/bash, and neither is inside the Workspace.
function hostDeps(overrides: Partial<Parameters<typeof isApprovedReportExec>[1]["deps"]> = {}) {
  return {
    consultBinPath: async () => REAL_BIN,
    realpath: async (target: string) => (target === PATH_BASH ? SYSTEM_BASH : target),
    isExecutableFile: async (target: string) => target === PATH_BASH,
    pathEnv: "/usr/bin:/bin",
    ...overrides,
  };
}

async function approve(
  rawInput: unknown,
  deps: Parameters<typeof isApprovedReportExec>[1]["deps"] = hostDeps(),
): Promise<boolean> {
  return await isApprovedReportExec(rawInput, { cwd: WORKSPACE, workspaceRoot: WORKSPACE, deps });
}
