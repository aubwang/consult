import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  cleanupIsolatedWorkspace,
  finalizeIsolatedWorkspace,
  isolatedTransactionRoot,
  prepareIsolatedWorkspace,
} from "./isolated-workspace.mts";
import type {
  IsolatedWorkspaceError,
  PreparedIsolatedWorkspace,
} from "./isolated-workspace.mts";

const execFileAsync = promisify(execFile);

test("prepare seeds staged, unstaged, binary, and safe untracked changes", async (t) => {
  const fixture = await makeRepository(t);
  await fs.writeFile(path.join(fixture.workspaceRoot, "staged.txt"), "user staged\n");
  await git(fixture.workspaceRoot, "add", "staged.txt");
  const binary = Buffer.from([0, 1, 2, 3, 255, 0, 4]);
  await fs.writeFile(path.join(fixture.workspaceRoot, "tracked.bin"), binary);
  await git(fixture.workspaceRoot, "add", "tracked.bin");
  await fs.writeFile(path.join(fixture.workspaceRoot, "unstaged.txt"), "user unstaged\n");
  await fs.mkdir(path.join(fixture.workspaceRoot, "notes"));
  await fs.writeFile(path.join(fixture.workspaceRoot, "notes", "untracked.txt"), "untracked\n");
  await fs.mkdir(path.join(fixture.workspaceRoot, "ignored"));
  await fs.writeFile(path.join(fixture.workspaceRoot, "ignored", "dependency.bin"), "ignored\n");

  const prepared = await prepareIsolatedWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    jobId: "job-seed",
    now: () => "2026-07-09T10:00:00.000Z",
  });
  fixture.prepared.push(prepared);

  assert.equal(prepared.workspaceRoot, await fs.realpath(fixture.workspaceRoot));
  assert.notEqual(prepared.executionRoot, prepared.workspaceRoot);
  assert.equal(prepared.executionRoot.startsWith(fixture.dataDir), true);
  assert.equal(await fs.readFile(path.join(prepared.executionRoot, "staged.txt"), "utf8"), "user staged\n");
  assert.equal(
    await fs.readFile(path.join(prepared.executionRoot, "unstaged.txt"), "utf8"),
    "user unstaged\n",
  );
  assert.deepEqual(await fs.readFile(path.join(prepared.executionRoot, "tracked.bin")), binary);
  assert.equal(
    await fs.readFile(path.join(prepared.executionRoot, "notes", "untracked.txt"), "utf8"),
    "untracked\n",
  );
  await assert.rejects(fs.access(path.join(prepared.executionRoot, "ignored", "dependency.bin")));

  assert.deepEqual(
    await gitPathList(prepared.executionRoot, "diff", "--cached", "--name-only", "-z"),
    ["staged.txt", "tracked.bin"],
  );
  assert.deepEqual(
    await gitPathList(prepared.executionRoot, "diff", "--name-only", "-z"),
    ["unstaged.txt"],
  );
  assert.deepEqual(
    await gitPathList(
      prepared.executionRoot,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ),
    ["notes/untracked.txt"],
  );
  assert.deepEqual(prepared.seeded.untrackedFiles, ["notes/untracked.txt"]);
  assert.ok(prepared.seeded.stagedPatchBytes > 0);
  assert.ok(prepared.seeded.unstagedPatchBytes > 0);
});

test("finalize emits the agent delta with binary new files and persistent cleanup metadata", async (t) => {
  const fixture = await makeRepository(t);
  await fs.writeFile(path.join(fixture.workspaceRoot, "staged.txt"), "user baseline\n");
  await git(fixture.workspaceRoot, "add", "staged.txt");
  await fs.writeFile(path.join(fixture.workspaceRoot, "seed.txt"), "remove me\n");

  const prepared = await prepareIsolatedWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    jobId: "job-finalize",
    now: () => "2026-07-09T10:00:00.000Z",
  });
  fixture.prepared.push(prepared);

  const finalBinary = Buffer.from([0, 255, 0, 1, 2, 3, 4, 0, 9]);
  await fs.writeFile(path.join(prepared.executionRoot, "staged.txt"), "agent final\n");
  await fs.rm(path.join(prepared.executionRoot, "seed.txt"));
  await fs.writeFile(path.join(prepared.executionRoot, "new.bin"), finalBinary);
  await fs.mkdir(path.join(prepared.executionRoot, "ignored"));
  await fs.writeFile(path.join(prepared.executionRoot, "ignored", "cache.bin"), "ignored agent output\n");

  const finalized = await finalizeIsolatedWorkspace(prepared, {
    now: () => "2026-07-09T10:01:00.000Z",
  });

  assert.deepEqual(finalized.touchedFiles, ["new.bin", "seed.txt", "staged.txt"]);
  assert.ok(finalized.patchBytes > 0);
  const patch = await fs.readFile(finalized.patchPath, "utf8");
  assert.match(patch, /GIT binary patch/);
  assert.match(patch, /new\.bin/);
  assert.doesNotMatch(patch, /ignored\/cache\.bin/);
  assert.doesNotMatch(patch, /unstaged\.txt/);
  assert.deepEqual(JSON.parse(await fs.readFile(finalized.touchedFilesPath, "utf8")), {
    schemaVersion: 1,
    jobId: "job-finalize",
    workspaceRoot: prepared.workspaceRoot,
    baselineTree: prepared.baselineTree,
    files: ["new.bin", "seed.txt", "staged.txt"],
  });

  // The artifact is an actionable delta against the original dirty snapshot,
  // not a replay of the user's pre-existing changes from HEAD.
  await git(fixture.workspaceRoot, "apply", "--binary", finalized.patchPath);
  assert.equal(await fs.readFile(path.join(fixture.workspaceRoot, "staged.txt"), "utf8"), "agent final\n");
  assert.deepEqual(await fs.readFile(path.join(fixture.workspaceRoot, "new.bin")), finalBinary);
  await assert.rejects(fs.access(path.join(fixture.workspaceRoot, "seed.txt")));

  const cleaned = await cleanupIsolatedWorkspace(prepared, {
    now: () => "2026-07-09T10:02:00.000Z",
  });
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.finalizedAt, "2026-07-09T10:01:00.000Z");
  assert.equal(cleaned.cleanedAt, "2026-07-09T10:02:00.000Z");
  await assert.rejects(fs.access(prepared.executionRoot));
  assert.ok(await fs.stat(finalized.patchPath));

  const cleanedAgain = await cleanupIsolatedWorkspace(prepared, {
    now: () => "later-must-not-replace-the-first-cleanup-time",
  });
  assert.deepEqual(cleanedAgain, cleaned);
});

test("prepare rejects untracked symlinks and removes partial transaction state", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-dependent on Windows");
    return;
  }
  const fixture = await makeRepository(t);
  await fs.symlink(os.tmpdir(), path.join(fixture.workspaceRoot, "outside-link"));

  await assert.rejects(
    prepareIsolatedWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      jobId: "job-symlink",
    }),
    (error: IsolatedWorkspaceError) => error.code === "UNTRACKED_SYMLINK",
  );
  await assert.rejects(
    fs.access(isolatedTransactionRoot(fixture.workspaceRoot, "job-symlink")),
  );
  const worktreeList = await gitText(fixture.workspaceRoot, "worktree", "list", "--porcelain");
  assert.doesNotMatch(worktreeList, /job-symlink/);
});

test("finalize refuses an untracked symlink created by the delegated agent", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-dependent on Windows");
    return;
  }
  const fixture = await makeRepository(t);
  const prepared = await prepareIsolatedWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    jobId: "job-agent-symlink",
  });
  fixture.prepared.push(prepared);
  await fs.symlink(os.tmpdir(), path.join(prepared.executionRoot, "agent-link"));

  await assert.rejects(
    finalizeIsolatedWorkspace(prepared),
    (error: IsolatedWorkspaceError) => error.code === "UNTRACKED_SYMLINK",
  );
  await assert.rejects(fs.access(path.join(prepared.artifactsDir, "changes.patch")));
});

test("job ids cannot traverse Consult-owned state", async (t) => {
  const fixture = await makeRepository(t);
  await assert.rejects(
    prepareIsolatedWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      jobId: "../escape",
    }),
    (error: IsolatedWorkspaceError) => error.code === "INVALID_JOB_ID",
  );
  assert.throws(
    () => isolatedTransactionRoot(fixture.workspaceRoot, "nested/job"),
    (error: IsolatedWorkspaceError) => error.code === "INVALID_JOB_ID",
  );
});

test("different job ids own independent worktrees and duplicate ids fail closed", async (t) => {
  const fixture = await makeRepository(t);
  const [first, second] = await Promise.all([
    prepareIsolatedWorkspace({ workspaceRoot: fixture.workspaceRoot, jobId: "job-a" }),
    prepareIsolatedWorkspace({ workspaceRoot: fixture.workspaceRoot, jobId: "job-b" }),
  ]);
  fixture.prepared.push(first, second);

  assert.notEqual(first.executionRoot, second.executionRoot);
  assert.ok(await fs.stat(first.executionRoot));
  assert.ok(await fs.stat(second.executionRoot));
  await assert.rejects(
    prepareIsolatedWorkspace({ workspaceRoot: fixture.workspaceRoot, jobId: "job-a" }),
    (error: IsolatedWorkspaceError) => error.code === "ISOLATED_WORKSPACE_EXISTS",
  );
});

test("prepare explains that isolated write Jobs require an initial commit", async (t) => {
  const fixture = await makeRepository(t, { commit: false });

  await assert.rejects(
    prepareIsolatedWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      jobId: "job-unborn",
    }),
    (error: IsolatedWorkspaceError) => {
      assert.equal(error.code, "ISOLATED_WORKSPACE_REQUIRES_COMMIT");
      assert.equal(
        error.message,
        "isolated write Jobs require a repository with at least one commit",
      );
      return true;
    },
  );
  await assert.rejects(
    fs.access(isolatedTransactionRoot(fixture.workspaceRoot, "job-unborn")),
  );
});

interface RepositoryFixture {
  root: string;
  workspaceRoot: string;
  dataDir: string;
  prepared: PreparedIsolatedWorkspace[];
}

async function makeRepository(
  t: TestContext,
  { commit = true }: { commit?: boolean } = {},
): Promise<RepositoryFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-isolated-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const prepared: PreparedIsolatedWorkspace[] = [];
  await fs.mkdir(workspaceRoot);
  const previousDataDir = process.env.CONSULT_DATA_DIR;
  process.env.CONSULT_DATA_DIR = dataDir;

  t.after(async () => {
    for (const isolated of prepared) {
      await cleanupIsolatedWorkspace(isolated).catch(() => {});
    }
    if (previousDataDir === undefined) {
      delete process.env.CONSULT_DATA_DIR;
    } else {
      process.env.CONSULT_DATA_DIR = previousDataDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  await git(workspaceRoot, "init");
  await git(workspaceRoot, "config", "user.name", "Consult Test");
  await git(workspaceRoot, "config", "user.email", "consult@example.invalid");
  await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored/\n");
  await fs.writeFile(path.join(workspaceRoot, "staged.txt"), "base staged\n");
  await fs.writeFile(path.join(workspaceRoot, "unstaged.txt"), "base unstaged\n");
  await fs.writeFile(path.join(workspaceRoot, "tracked.bin"), Buffer.from([0, 8, 7, 0]));
  if (commit) {
    await git(workspaceRoot, "add", ".");
    await git(workspaceRoot, "commit", "-m", "initial");
  }

  return { root, workspaceRoot, dataDir, prepared };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function gitPathList(cwd: string, ...args: string[]): Promise<string[]> {
  return (await gitText(cwd, ...args)).split("\0").filter(Boolean);
}
