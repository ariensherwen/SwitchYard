import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import {
  addProject,
  createProject,
  recoverProjectRelocations,
  relocateProject,
  renameProject,
  unregisterProject,
} from "../src/projects.ts";
import { now, StateStore } from "../src/state.ts";
import { cancelTask, createTask, startTask } from "../src/tasks.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-projects-"));
  dirs.push(root);
  const paths = await ensureSwitchYardHome({
    ...process.env,
    SWITCHYARD_HOME: path.join(root, "home"),
  });
  const store = new StateStore(paths.database);
  return { root, paths, store };
}

test("creating a Project produces a clean empty Git base that can own a Task Workspace", async () => {
  const { root, paths, store } = await fixture();
  const project = await createProject(store, paths, "New project", path.join(root, "new-project"));
  assert.equal(project.name, "New project");
  assert.equal(project.registration_state, "registered");
  assert.equal(await git(project.root_path, ["status", "--porcelain"]), "");
  assert.equal(await git(project.root_path, ["ls-tree", "--name-only", "HEAD"]), "");

  const task = createTask(store, project.id, "implement", "scaffold the project", "loop");
  await startTask(store, paths, task.id);
  const started = store.getTask(task.id);
  assert.ok(started?.base_sha);
  assert.equal(started?.base_ref, await git(project.root_path, ["branch", "--show-current"]));
  const workspace = store.getWorkspace(task.id);
  assert.equal(workspace?.provisioned, 1);
  assert.ok(workspace);
  assert.equal(await git(workspace.path, ["rev-parse", "HEAD"]), started?.base_sha);
  store.close();
});

test("registration lifecycle keeps Tasks durable and refuses to move retained Workspaces", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Kinetix");
  const task = createTask(store, project.id, "implement", "change something", "off", "Fix search");
  assert.throws(() => unregisterProject(store, project.id), /active Tasks/);

  await startTask(store, paths, task.id);
  cancelTask(store, task.id);
  await assert.rejects(
    () => relocateProject(store, paths, project.id, path.join(root, "moved")),
    /retained Task Workspaces/,
  );
  const unregistered = unregisterProject(store, project.id);
  assert.equal(unregistered.registration_state, "unregistered");
  assert.equal(
    store.listProjects().some((entry) => entry.id === project.id),
    false,
  );
  assert.equal(store.getTask(task.id)?.title, "Fix search");
  store.close();
});

test("rename and relocation preserve the registered Project identity", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Before");
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const renamed = await renameProject(store, project.id, "After");
  assert.equal(renamed.id, project.id);
  assert.equal(renamed.name, "After");

  const relocated = await relocateProject(
    store,
    paths,
    project.id,
    path.join(root, "new-location"),
  );
  assert.equal(relocated.id, project.id);
  assert.equal(relocated.name, "After");
  assert.equal(relocated.root_path, path.join(root, "new-location"));
  assert.equal(
    await git(relocated.root_path, ["config", "--local", "--get", "switchyard.projectIdentity"]),
    project.git_identity,
  );
  assert.equal(await git(relocated.root_path, ["rev-parse", "HEAD"]), head);
  assert.equal(store.getProject(project.id)?.registration_state, "registered");
  store.close();
});

test("Task startup cannot provision a Workspace during Project relocation", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Kinetix");
  let signalReserved!: () => void;
  let releaseRelocation!: () => void;
  const reserved = new Promise<void>((resolve) => {
    signalReserved = resolve;
  });
  const relocationGate = new Promise<void>((resolve) => {
    releaseRelocation = resolve;
  });
  const relocation = relocateProject(store, paths, project.id, path.join(root, "moved"), {
    afterReservation: async () => {
      signalReserved();
      await relocationGate;
    },
  });
  await reserved;

  const concurrentStore = new StateStore(paths.database);
  assert.throws(
    () => createTask(concurrentStore, project.id, "implement", "change something", "off"),
    /while its Project is being relocated/,
  );
  const taskId = "stale-writer-task";
  concurrentStore.transaction(() => {
    concurrentStore.db
      .prepare(`INSERT INTO tasks(
        id, project_id, title, kind, instruction, review_policy, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'implement', ?, 'off', 'queued', ?, ?)`)
      .run(taskId, project.id, "Stale writer", "change something", now(), now());
  });
  await assert.rejects(() => startTask(concurrentStore, paths, taskId), /is being relocated/);
  assert.equal(concurrentStore.getWorkspace(taskId), undefined);
  releaseRelocation();
  const moved = await relocation;
  assert.equal(moved.root_path, path.join(root, "moved"));
  await startTask(concurrentStore, paths, taskId);
  assert.equal(concurrentStore.getWorkspace(taskId)?.provisioned, 1);
  concurrentStore.close();
  store.close();
});

test("recovery completes a Project move interrupted after the filesystem rename", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Kinetix");
  const moved = path.join(root, "moved");
  const token = "interrupted-relocation";
  await rename(repo, moved);
  store.transaction(() => {
    store.db
      .prepare(`UPDATE projects SET relocation_token=?, relocation_destination=?, relocation_pid=?
        WHERE id=?`)
      .run(token, moved, 1_000_000_000, project.id);
  });

  await recoverProjectRelocations(store);
  const recovered = store.getProject(project.id);
  assert.equal(recovered?.root_path, moved);
  assert.equal(recovered?.relocation_token, null);
  assert.ok(store.listEvents().some((event) => event.type === "project.relocated"));
  store.close();
});

test("registration repairs a missing Project path when the same checkout identity is found", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Kinetix");
  const moved = path.join(root, "moved");
  await rename(repo, moved);

  const repaired = await addProject(store, paths, moved);
  assert.equal(repaired.id, project.id);
  assert.equal(repaired.name, "Kinetix");
  assert.equal(repaired.root_path, moved);
  assert.ok(store.listEvents().some((event) => event.type === "project.relocated"));
  store.close();
});

test("registration requires confirmation before replacing a changed repository identity", async () => {
  const { root, paths, store } = await fixture();
  const repo = await initRepo(path.join(root, "repo"));
  const project = await addProject(store, paths, repo, "Kinetix");
  await rm(repo, { recursive: true, force: true });
  await initRepo(repo);

  await assert.rejects(
    () => addProject(store, paths, repo, "Kinetix"),
    /ask for confirmation before replacing/,
  );
  const replaced = await addProject(store, paths, repo, undefined, {
    confirmIdentityChange: true,
  });
  assert.equal(replaced.id, project.id);
  assert.notEqual(replaced.git_identity, project.git_identity);
  assert.ok(store.listEvents().some((event) => event.type === "project.identity_replaced"));
  store.close();
});

test("Project destinations reached through symlinks cannot enter managed storage", async () => {
  const { root, paths, store } = await fixture();
  const alias = path.join(root, "managed-worktrees");
  await symlink(paths.worktrees, alias);
  await assert.rejects(
    () => createProject(store, paths, "Unsafe", path.join(alias, "project")),
    /inside SwitchYard-managed storage/,
  );
  store.close();
});

async function initRepo(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: directory });
  await exec("git", ["config", "user.name", "Test"], { cwd: directory });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await writeFile(path.join(directory, "tracked.txt"), "base\n");
  await exec("git", ["add", "tracked.txt"], { cwd: directory });
  await exec("git", ["commit", "-m", "base"], { cwd: directory });
  return directory;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}
