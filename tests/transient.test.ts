import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { StateStore } from "../src/state.ts";
import {
  cancelTask,
  cleanupTerminalTransientTask,
  createTransientInvestigation,
  markRunning,
  startTask,
  submitCandidate,
} from "../src/tasks.ts";
import { resolveRemoteRevision } from "../src/worktree.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-transient-"));
  dirs.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await exec("git", ["init", "-b", "main"], { cwd: source });
  await exec("git", ["config", "user.name", "Test"], { cwd: source });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await writeFile(path.join(source, "source.txt"), "inspect me\n");
  await exec("git", ["add", "source.txt"], { cwd: source });
  await exec("git", ["commit", "-m", "source"], { cwd: source });
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const paths = await ensureSwitchYardHome({
    ...process.env,
    SWITCHYARD_HOME: path.join(root, "home"),
  });
  const store = new StateStore(paths.database);
  const task = createTransientInvestigation(
    store,
    paths,
    source,
    "Inspect the pinned source without changing it",
    "Kinetix issue #142 investigation",
    "Kinetix issue #142",
    revision,
    "refs/heads/main",
  );
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const workspace = store.getWorkspace(task.id);
  assert.ok(workspace);
  assert.ok(task.source_path);
  return {
    paths,
    store,
    taskId: task.id,
    sourcePath: task.source_path,
    workspacePath: workspace.path,
    source,
    revision,
  };
}

test("remote refs must resolve to one full commit SHA", async () => {
  const { source, revision, store } = await fixture();
  assert.equal(await resolveRemoteRevision(source, "refs/heads/main"), revision);
  await assert.rejects(
    () => resolveRemoteRevision(source, "refs/heads/missing"),
    /did not resolve to one concrete Git commit/,
  );
  store.close();
});

test("transient source URL, ref, and revision cannot be changed after Task creation", async () => {
  const { store, taskId } = await fixture();
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE tasks SET source_url='https://example.invalid/other.git' WHERE id=?")
        .run(taskId),
    /task source URL is immutable/,
  );
  assert.throws(
    () => store.db.prepare("UPDATE tasks SET source_ref='refs/heads/other' WHERE id=?").run(taskId),
    /task source ref is immutable/,
  );
  assert.throws(
    () =>
      store.db.prepare("UPDATE tasks SET source_revision=? WHERE id=?").run("0".repeat(40), taskId),
    /task source revision is immutable/,
  );
  store.close();
});

test("terminal transient investigations remove only their unchanged pinned checkout", async () => {
  const { paths, store, taskId, sourcePath, workspacePath } = await fixture();
  const completed = await submitCandidate(
    store,
    taskId,
    "Inspected the source",
    "No files changed",
  );
  assert.equal(completed.task.state, "completed");
  assert.equal(await cleanupTerminalTransientTask(store, paths, taskId), "cleaned");
  assert.equal(existsSync(sourcePath), false);
  assert.equal(existsSync(workspacePath), false);
  assert.equal(store.getWorkspace(taskId)?.provisioned, 0);
  assert.ok(store.listEvents(taskId).some((event) => event.type === "transient_source.cleaned"));
  store.close();
});

test("transient cleanup preserves terminal workspaces when local changes remain", async () => {
  const { paths, store, taskId, sourcePath, workspacePath } = await fixture();
  cancelTask(store, taskId);
  await writeFile(path.join(workspacePath, "uncommitted.txt"), "keep me\n");
  assert.equal(await cleanupTerminalTransientTask(store, paths, taskId), "preserved");
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(workspacePath), true);
  assert.equal(store.getWorkspace(taskId)?.provisioned, 1);
  store.close();
});
