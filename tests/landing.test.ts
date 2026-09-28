import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { landCompletedTask } from "../src/landing.ts";
import { addProject } from "../src/projects.ts";
import { publishCompletedTask } from "../src/publish.ts";
import { StateStore } from "../src/state.ts";
import { createTask, markRunning, startTask, submitCandidate } from "../src/tasks.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

async function fixture(withRemote = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-land-project-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  const paths = await ensureSwitchYardHome({ ...process.env, SWITCHYARD_HOME: home });
  const store = new StateStore(paths.database);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(path.join(repo, "file.txt"), "base\n");
  await exec("git", ["add", "file.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const project = await addProject(store, paths, repo, "Kinetix");
  const task = createTask(store, project.id, "implement", "change the file", "off", "Fix the file");
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const workspace = store.getWorkspace(task.id);
  assert.ok(workspace);
  await writeFile(path.join(workspace.path, "file.txt"), "candidate\n");
  await exec("git", ["add", "file.txt"], { cwd: workspace.path });
  await exec("git", ["commit", "-m", "candidate"], { cwd: workspace.path });
  const submitted = await submitCandidate(store, task.id, "Updated the file", "Tests pass");
  assert.equal(submitted.task.state, "completed");
  assert.ok(submitted.candidateSha);
  const completedTask = store.getTask(task.id);
  assert.ok(completedTask?.base_sha);
  let remote: string | undefined;
  if (withRemote) {
    remote = path.join(root, "remote.git");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
  }
  return {
    root,
    repo,
    paths,
    store,
    taskId: task.id,
    candidateSha: submitted.candidateSha,
    baseSha: completedTask.base_sha,
    remote,
  };
}

test("landing fast-forwards only the captured Project branch and preserves the Task candidate", async () => {
  const { repo, store, taskId, candidateSha, baseSha } = await fixture();
  const landed = await landCompletedTask(store, taskId);
  assert.equal(landed.status, "landed");
  if (landed.status !== "landed") throw new Error("expected landing success");
  assert.equal(landed.project, "Kinetix");
  assert.equal(landed.candidate_sha, candidateSha);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), candidateSha);
  assert.equal(store.getWorkspace(taskId)?.provisioned, 0);
  assert.equal(store.getTask(taskId)?.base_sha, baseSha);
  assert.ok(store.listEvents(taskId).some((event) => event.type === "task.landed"));
  store.close();
});

test("landing ignores ignored files in an otherwise clean Project checkout", async () => {
  const { repo, store, taskId, candidateSha } = await fixture();
  await writeFile(path.join(repo, ".git", "info", "exclude"), "ignored.tmp\n");
  await writeFile(path.join(repo, "ignored.tmp"), "ignored\n");
  assert.equal(await git(repo, ["status", "--porcelain"]), "");

  const landed = await landCompletedTask(store, taskId);
  assert.equal(landed.status, "landed");
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), candidateSha);
  store.close();
});

test("landing reports the actual dirty paths when refusing", async () => {
  const { repo, store, taskId } = await fixture();
  await writeFile(path.join(repo, "local.txt"), "local-only\n");
  await assert.rejects(() => landCompletedTask(store, taskId), /\?\? local\.txt/);
  store.close();
});

test("landing refuses an advanced Project without rewriting either side", async () => {
  const { repo, store, taskId, candidateSha, baseSha } = await fixture();
  await writeFile(path.join(repo, "other.txt"), "another change\n");
  await exec("git", ["add", "other.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "advance Project"], { cwd: repo });
  const targetSha = await git(repo, ["rev-parse", "HEAD"]);
  const outcome = await landCompletedTask(store, taskId);
  assert.equal(outcome.status, "diverged");
  if (outcome.status !== "diverged") throw new Error("expected divergence refusal");
  assert.equal(outcome.target_sha, targetSha);
  assert.equal(outcome.base_sha, baseSha);
  assert.equal(outcome.candidate_sha, candidateSha);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), targetSha);
  assert.equal(store.getWorkspace(taskId)?.provisioned, 1);
  store.close();
});

test("publishing pushes only the exact candidate to the selected branch", async () => {
  const { repo, store, taskId, candidateSha, baseSha, remote } = await fixture(true);
  assert.ok(remote);
  const result = await publishCompletedTask(store, taskId, "fix/issue-142", ["origin"]);
  assert.equal(result.project, "Kinetix");
  assert.equal(result.candidate_sha, candidateSha);
  assert.deepEqual(result.targets, [{ remote: "origin", status: "pushed" }]);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/fix/issue-142"]), candidateSha);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), baseSha);
  assert.equal(store.getTask(taskId)?.state, "completed");
  assert.ok(store.listEvents(taskId).some((event) => event.type === "task.published"));
  store.close();
});

test("publishing without a selected remote uses a single unambiguous Git remote", async () => {
  const { store, taskId, candidateSha, remote } = await fixture(true);
  assert.ok(remote);
  const result = await publishCompletedTask(store, taskId, "fix/issue-142");
  assert.deepEqual(result.targets, [{ remote: "origin", status: "pushed" }]);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/fix/issue-142"]), candidateSha);
  store.close();
});

test("publishing asks for a remote when multiple Git remotes are ambiguous", async () => {
  const { root, repo, store, taskId } = await fixture(true);
  const secondRemote = path.join(root, "second.git");
  await exec("git", ["init", "--bare", secondRemote]);
  await exec("git", ["remote", "add", "gitlab", secondRemote], { cwd: repo });
  await assert.rejects(
    () => publishCompletedTask(store, taskId, "fix/issue-142"),
    /push target is ambiguous/,
  );
  store.close();
});

test("publishing may explicitly push the candidate to multiple selected remotes", async () => {
  const { root, repo, store, taskId, candidateSha, remote } = await fixture(true);
  assert.ok(remote);
  const secondRemote = path.join(root, "second.git");
  await exec("git", ["init", "--bare", secondRemote]);
  await exec("git", ["remote", "add", "gitlab", secondRemote], { cwd: repo });
  const result = await publishCompletedTask(store, taskId, "fix/issue-142", ["origin", "gitlab"]);
  assert.deepEqual(result.targets, [
    { remote: "origin", status: "pushed" },
    { remote: "gitlab", status: "pushed" },
  ]);
  assert.equal(await git(remote, ["rev-parse", "refs/heads/fix/issue-142"]), candidateSha);
  assert.equal(await git(secondRemote, ["rev-parse", "refs/heads/fix/issue-142"]), candidateSha);
  store.close();
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}
