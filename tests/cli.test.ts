import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { StateStore, now } from "../src/state.ts";
import { createTask } from "../src/tasks.ts";
import { createWorkspace } from "../src/worktree.ts";

const exec = promisify(execFile); const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const cli = path.join(root, "src", "cli.ts"); const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try { const { stdout, stderr } = await exec(process.execPath, ["--experimental-strip-types", cli, ...args], { cwd: root, env }); return { code: 0, stdout, stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }; }
}

test("help exposes the 0.1.0 task surface", async () => {
  const result = await run(["--help"]); assert.equal(result.code, 0); assert.match(result.stdout, /project add/); assert.match(result.stdout, /task create/); assert.match(result.stdout, /task clean/);
});

test("version remains package 0.1.0", async () => {
  const result = await run(["--version"]); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "0.1.0");
});

test("project add/list persists under SWITCHYARD_HOME", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-repo-")); const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-home-")); dirs.push(repo, home);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  const env = { ...process.env, SWITCHYARD_HOME: home };
  const added = await run(["project", "add", repo], env); assert.equal(added.code, 0); const id = added.stdout.split("\t")[0]?.trim(); assert.ok(id);
  const listed = await run(["project", "list"], env); assert.equal(listed.code, 0); assert.match(listed.stdout, new RegExp(id)); assert.match(listed.stdout, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});


test("task clean refuses a nonterminal workspace without deleting it", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "switchyard-clean-repo-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-clean-home-"));
  dirs.push(repo, home);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });

  const env = { ...process.env, SWITCHYARD_HOME: home };
  const paths = await ensureSwitchYardHome(env);
  const store = new StateStore(paths.database);
  store.db.prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, ?)").run(repo, now());
  const task = createTask(store, "p", "implement", "work", "off");
  const workspacePath = path.join(paths.worktrees, "p", task.id);
  const workspace = await createWorkspace(repo, workspacePath, `switchyard/task-${task.id}`);
  store.db.prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
    .run(task.id, workspace.path, workspace.branch, now());
  store.db.prepare("UPDATE tasks SET base_sha=? WHERE id=?").run(workspace.baseSha, task.id);
  store.close();

  const cleaned = await run(["task", "clean", task.id], env);
  assert.equal(cleaned.code, 1);
  assert.match(cleaned.stderr, /only terminal Tasks can be cleaned/);
  await access(workspace.path);
});
