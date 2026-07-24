import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { jobArtifactsDir } from "./broker-endpoint.mts";
import {
  archiveConfinedSessionState,
  restoreConfinedSessionState,
  validateConfinedSessionStateArchive,
} from "./confined-session-state.mts";

test("Codex session archive restores only the selected transcript", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "session-target";
  const target = path.join(
    fixture.home,
    ".codex/sessions/2026/07/10",
    `rollout-now-${sessionId}.jsonl`,
  );
  const other = path.join(
    fixture.home,
    ".codex/sessions/2026/07/09",
    "rollout-earlier-session-other.jsonl",
  );
  await writePrivateFile(target, "target transcript\n");
  await writePrivateFile(other, "other transcript\n");
  await writePrivateFile(path.join(fixture.home, ".codex/auth.json"), "credential\n");

  await archiveConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "codex",
    sessionId,
    privateHome: fixture.home,
  });
  await validateConfinedSessionStateArchive({
    ...fixture.input,
    profileRegistryId: "codex",
    sessionId,
  });
  await restoreConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "codex",
    sessionId,
    privateHome: fixture.restoredHome,
  });

  assert.equal(
    await fs.readFile(
      path.join(
        fixture.restoredHome,
        ".codex/sessions/2026/07/10",
        `rollout-now-${sessionId}.jsonl`,
      ),
      "utf8",
    ),
    "target transcript\n",
  );
  await assert.rejects(fs.access(path.join(fixture.restoredHome, ".codex/auth.json")));
  await assert.rejects(
    fs.access(
      path.join(
        fixture.restoredHome,
        ".codex/sessions/2026/07/09/rollout-earlier-session-other.jsonl",
      ),
    ),
  );
});

test("Claude session archive preserves its project-relative transcript path", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "claude-session";
  const target = path.join(
    fixture.home,
    ".claude/projects/-tmp-workspace",
    `${sessionId}.jsonl`,
  );
  await writePrivateFile(target, "claude transcript\n");
  await writePrivateFile(
    path.join(fixture.home, ".claude/projects/-tmp-other/other-session.jsonl"),
    "other\n",
  );

  await archiveConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "claude",
    sessionId,
    privateHome: fixture.home,
  });
  await restoreConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "claude",
    sessionId,
    privateHome: fixture.restoredHome,
  });

  assert.equal(
    await fs.readFile(
      path.join(
        fixture.restoredHome,
        ".claude/projects/-tmp-workspace",
        `${sessionId}.jsonl`,
      ),
      "utf8",
    ),
    "claude transcript\n",
  );
  await assert.rejects(
    fs.access(
      path.join(
        fixture.restoredHome,
        ".claude/projects/-tmp-other/other-session.jsonl",
      ),
    ),
  );
});

test("Grok session archive carries conversation state and drops the rest", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "01997f00-0000-7000-8000-00000000abcd";
  const group = "%2Ftmp%2Fworkspace";
  const sessionDir = path.join(fixture.home, ".grok/sessions", group, sessionId);
  await writePrivateFile(path.join(sessionDir, "updates.jsonl"), "grok updates\n");
  await writePrivateFile(path.join(sessionDir, "summary.json"), "{\"info\":1}\n");
  await writePrivateFile(path.join(sessionDir, "chat_history.jsonl"), "grok chat\n");
  await writePrivateFile(path.join(sessionDir, "rewind_points.jsonl"), "workspace snapshots\n");
  await writePrivateFile(path.join(sessionDir, "feedback.jsonl"), "ratings\n");
  await writePrivateFile(path.join(sessionDir, "subagents/child/meta.json"), "child\n");
  await writePrivateFile(path.join(fixture.home, ".grok/auth.json"), "credential\n");
  await writePrivateFile(path.join(fixture.home, ".grok/mcp_credentials.json"), "oauth\n");
  await writePrivateFile(
    path.join(fixture.home, ".grok/sessions", group, "other-session/updates.jsonl"),
    "other\n",
  );

  await archiveConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "grok",
    sessionId,
    privateHome: fixture.home,
  });
  await validateConfinedSessionStateArchive({
    ...fixture.input,
    profileRegistryId: "grok",
    sessionId,
  });
  await restoreConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "grok",
    sessionId,
    privateHome: fixture.restoredHome,
  });

  const restoredSessionDir = path.join(
    fixture.restoredHome,
    ".grok/sessions",
    group,
    sessionId,
  );
  assert.deepEqual((await fs.readdir(restoredSessionDir)).sort(), [
    "chat_history.jsonl",
    "summary.json",
    "updates.jsonl",
  ]);
  assert.equal(
    await fs.readFile(path.join(restoredSessionDir, "updates.jsonl"), "utf8"),
    "grok updates\n",
  );
  for (const excluded of [
    ".grok/auth.json",
    ".grok/mcp_credentials.json",
    `.grok/sessions/${group}/other-session/updates.jsonl`,
  ]) {
    await assert.rejects(fs.access(path.join(fixture.restoredHome, excluded)));
  }
});

test("Grok session archive fails closed without the authoritative update log", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "01997f00-0000-7000-8000-00000000beef";
  await writePrivateFile(
    path.join(fixture.home, ".grok/sessions/%2Ftmp%2Fworkspace", sessionId, "summary.json"),
    "{}\n",
  );

  await assert.rejects(
    archiveConfinedSessionState({
      ...fixture.input,
      profileRegistryId: "grok",
      sessionId,
      privateHome: fixture.home,
    }),
    /has no updates\.jsonl to archive/u,
  );
});

test("Grok session archive rejects an ambiguous Session id across cwd groups", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "01997f00-0000-7000-8000-00000000cafe";
  for (const group of ["%2Ftmp%2Fone", "%2Ftmp%2Ftwo"]) {
    await writePrivateFile(
      path.join(fixture.home, ".grok/sessions", group, sessionId, "updates.jsonl"),
      "updates\n",
    );
  }

  await assert.rejects(
    archiveConfinedSessionState({
      ...fixture.input,
      profileRegistryId: "grok",
      sessionId,
      privateHome: fixture.home,
    }),
    /expected exactly one grok Session directory/u,
  );
});

test("session archive validation rejects a manifest target outside the Session directory", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "01997f00-0000-7000-8000-00000000d00d";
  await writePrivateFile(
    path.join(fixture.home, ".grok/sessions/%2Ftmp%2Fworkspace", sessionId, "updates.jsonl"),
    "updates\n",
  );
  await archiveConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "grok",
    sessionId,
    privateHome: fixture.home,
  });

  const manifestPath = path.join(
    jobArtifactsDir(fixture.workspaceRoot, fixture.input.jobId),
    "session-state/manifest.json",
  );
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.files[0].targetPath = ".grok/auth.json";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    validateConfinedSessionStateArchive({
      ...fixture.input,
      profileRegistryId: "grok",
      sessionId,
    }),
    /disallowed target path|credential or shared history state/u,
  );
});

test("session archive validation rejects tampering and cwd changes", async (t) => {
  const fixture = await makeFixture(t);
  const sessionId = "session-tamper";
  await writePrivateFile(
    path.join(
      fixture.home,
      ".codex/sessions/2026/07/10",
      `rollout-now-${sessionId}.jsonl`,
    ),
    "original\n",
  );
  await archiveConfinedSessionState({
    ...fixture.input,
    profileRegistryId: "codex",
    sessionId,
    privateHome: fixture.home,
  });

  await assert.rejects(
    validateConfinedSessionStateArchive({
      ...fixture.input,
      cwd: path.join(fixture.workspaceRoot, "different"),
      profileRegistryId: "codex",
      sessionId,
    }),
    /does not match the requested Profile, Session, or cwd/u,
  );

  await fs.writeFile(
    path.join(jobArtifactsDir(fixture.workspaceRoot, fixture.input.jobId), "session-state/files/0"),
    "tampered\n",
  );
  await assert.rejects(
    validateConfinedSessionStateArchive({
      ...fixture.input,
      profileRegistryId: "codex",
      sessionId,
    }),
    /metadata does not match|hash does not match/u,
  );
});

async function makeFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-session-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const priorDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = path.join(root, "data");
  t.after(() => {
    if (priorDataDir === undefined) delete process.env.CONSULT_DATA_DIR;
    else process.env.CONSULT_DATA_DIR = priorDataDir;
  });
  const workspaceRoot = path.join(root, "workspace");
  const home = path.join(root, "home");
  const restoredHome = path.join(root, "restored-home");
  await Promise.all([
    fs.mkdir(workspaceRoot, { recursive: true }),
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(restoredHome, { recursive: true, mode: 0o700 }),
  ]);
  return {
    workspaceRoot,
    home,
    restoredHome,
    input: {
      workspaceRoot,
      jobId: `job-${path.basename(root)}`,
      cwd: workspaceRoot,
    },
  };
}

async function writePrivateFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, contents, { mode: 0o600 });
}
