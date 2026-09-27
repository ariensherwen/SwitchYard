import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import {
  canSafelyClean,
  canonicalRepositoryRoot,
  createWorkspace,
  validateImplementCandidate,
  removeWorktree,
} from "../src/worktree.ts";

const exec = promisify(execFile);
const dirs: string[] = [];

afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-git-"));
  dirs.push(root);
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

test("project path canonicalization collapses relative and symlink paths", async () => {
  const root = await repo();
  const link = `${root}-link`;
  dirs.push(link);
  await symlink(root, link);
  assert.equal(await canonicalRepositoryRoot(root), await canonicalRepositoryRoot(link));
});

test("implement candidate must be clean, committed, descendant, and on task branch", async () => {
  const root = await repo();
  const workspace = `${root}-worktree`;
  dirs.push(workspace);
  const info = await createWorkspace(root, workspace, "switchyard/task-t1");
  await writeFile(path.join(workspace, "README.md"), "changed\n");
  await assert.rejects(
    () => validateImplementCandidate(workspace, info.branch, info.baseSha),
    /must be clean/,
  );
  await exec("git", ["add", "."], { cwd: workspace });
  await exec("git", ["commit", "-m", "change"], { cwd: workspace });
  const candidate = await validateImplementCandidate(workspace, info.branch, info.baseSha);
  assert.notEqual(candidate, info.baseSha);
  assert.equal(await canSafelyClean(root, workspace, info.baseSha), false);
  await exec("git", ["merge", "--ff-only", info.branch], { cwd: root });
  assert.equal(await canSafelyClean(root, workspace, info.baseSha), true);
});

test("dirty registered project is rejected before worktree creation", async () => {
  const root = await repo();
  await writeFile(path.join(root, "dirty.txt"), "dirty");
  await assert.rejects(
    () => createWorkspace(root, `${root}-worktree`, "switchyard/task-t2"),
    /checkout is dirty/,
  );
});


test("cleanup refuses dirty worktree and failed Git removal preserves files", async () => {
  const root = await repo();
  const workspace = `${root}-dirty-worktree`;
  dirs.push(workspace);
  const info = await createWorkspace(root, workspace, "switchyard/task-dirty");
  const dirtyFile = path.join(workspace, "dirty.txt");
  await writeFile(dirtyFile, "valuable uncommitted work\n");

  assert.equal(await canSafelyClean(root, workspace, info.baseSha), false);
  await assert.rejects(() => removeWorktree(root, workspace));
  await access(workspace);
  await access(dirtyFile);
});
