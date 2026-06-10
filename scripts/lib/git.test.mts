import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { getDiff } from "./git.mts";

const execFileAsync = promisify(execFile);

test("getDiff returns working-tree status and diff", async () => {
  const repo = await makeRepo("working-tree");
  await fs.writeFile(path.join(repo, "note.txt"), "before\n");
  await git(repo, "add", "note.txt");
  await git(repo, "commit", "-m", "initial");
  await fs.writeFile(path.join(repo, "note.txt"), "after\n");

  const diff = await getDiff({ cwd: repo });

  assert.match(diff, /M note\.txt/);
  assert.match(diff, /diff --git a\/note\.txt b\/note\.txt/);
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
});

test("getDiff returns the diff from base ref to HEAD", async () => {
  const repo = await makeRepo("base-ref");
  await fs.writeFile(path.join(repo, "note.txt"), "first\n");
  await git(repo, "add", "note.txt");
  await git(repo, "commit", "-m", "first");
  const baseRef = (await gitOutput(repo, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(repo, "note.txt"), "second\n");
  await git(repo, "commit", "-am", "second");

  const diff = await getDiff({ baseRef, cwd: repo });

  assert.match(diff, /diff --git a\/note\.txt b\/note\.txt/);
  assert.match(diff, /-first/);
  assert.match(diff, /\+second/);
});

test("getDiff returns clean status output without throwing", async () => {
  const repo = await makeRepo("clean");
  await fs.writeFile(path.join(repo, "note.txt"), "clean\n");
  await git(repo, "add", "note.txt");
  await git(repo, "commit", "-m", "clean");

  const diff = await getDiff({ cwd: repo });

  assert.equal(diff, "");
});

async function makeRepo(name: string): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `consult-git-${name}-`));
  await git(repo, "init");
  await git(repo, "config", "user.email", "consult@example.invalid");
  await git(repo, "config", "user.name", "Consult Test");
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}
