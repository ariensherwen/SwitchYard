import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { reconcile } from "../src/reconcile.ts";
import { now, StateStore } from "../src/state.ts";
import { cancelTask, createTask, startTask } from "../src/tasks.ts";
import { createWorkspace } from "../src/worktree.ts";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
);

async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--experimental-strip-types", cli, ...args],
      { cwd: root, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function waitForFile(filePath: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`timed out waiting for ${filePath}`);
}

test("help leads with the Supervisor and keeps task commands available", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /project add/);
  assert.match(result.stdout, /task create/);
  assert.match(result.stdout, /task clean/);
});

test("recover reconciles a fresh state home", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-recover-"));
  dirs.push(home);
  const result = await run(["recover"], { ...process.env, SWITCHYARD_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Recovery complete.");
});

test("version reports package 0.1.1", async () => {
  const result = await run(["--version"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "0.1.1");
});

test("project add/list persists under SWITCHYARD_HOME", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-repo-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-home-"));
  dirs.push(repo, home);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  const env = { ...process.env, SWITCHYARD_HOME: home };
  const added = await run(["project", "add", repo, "--json"], env);
  assert.equal(added.code, 0);
  const project = JSON.parse(added.stdout) as { id: string };
  assert.ok(project.id);
  const listed = await run(["project", "list"], env);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /switchyard-cli-repo-/);
  assert.doesNotMatch(
    listed.stdout,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  const machineList = await run(["project", "list", "--json"], env);
  assert.match(machineList.stdout, new RegExp(project.id));
});

test("CLI reviews implement Tasks by default and supports explicit opt-out", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-review-"));
  dirs.push(rootDir);
  const repo = path.join(rootDir, "repo");
  const home = path.join(rootDir, "home");
  const bin = path.join(rootDir, "bin");
  const tmuxState = path.join(rootDir, "tmux-state");
  const tmuxCommands = path.join(rootDir, "tmux-commands");
  await mkdir(repo);
  await mkdir(bin);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const paths = await ensureSwitchYardHome({ SWITCHYARD_HOME: home });
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p', 'repo', ?, ?)")
    .run(repo, now());
  store.close();
  const tmux = path.join(bin, "tmux");
  await writeFile(
    tmux,
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(tmuxState)}\ncommands=${JSON.stringify(tmuxCommands)}\nprintf '%s\\n' "$1" >> "$commands"\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window) printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) i=0; while IFS= read -r name; do i=$((i+1)); printf '@%s\\t%s\\n' "$i" "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  capture-pane) echo 'read-only Worker pane' ;;\n  attach-session|switch-client) exit 99 ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(tmux, 0o755);
  const env = { ...process.env, SWITCHYARD_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;

  const defaultTask = await run(["task", "create", "p", "--json", "Implement with review"], env);
  assert.equal(defaultTask.code, 0, defaultTask.stderr);
  const defaultTaskId = (JSON.parse(defaultTask.stdout) as { task: { id: string } }).task.id;
  const attached = await run(["task", "attach", defaultTaskId], env);
  assert.equal(attached.code, 0, attached.stderr);
  assert.match(attached.stdout, /read-only Worker pane/);
  assert.doesNotMatch(await readFile(tmuxCommands, "utf8"), /attach-session|switch-client/);
  const optOutTask = await run(
    ["task", "create", "p", "--json", "--no-review", "Implement without review"],
    env,
  );
  assert.equal(optOutTask.code, 0, optOutTask.stderr);
  const investigateTask = await run(
    ["task", "create", "p", "--json", "--kind", "investigate", "Inspect without review"],
    env,
  );
  assert.equal(investigateTask.code, 0, investigateTask.stderr);
  const invalidInvestigation = await run(
    ["task", "create", "p", "--kind", "investigate", "--review", "Invalid review"],
    env,
  );
  assert.equal(invalidInvestigation.code, 1);
  assert.match(invalidInvestigation.stderr, /--review is supported only for implement tasks/);

  const verified = new StateStore(paths.database);
  assert.equal(
    verified.listTasks().find((task) => task.id === defaultTaskId)?.review_policy,
    "loop",
  );
  assert.equal(
    verified.listTasks().find((task) => task.title === "Implement without review")?.review_policy,
    "off",
  );
  assert.equal(
    verified.listTasks().find((task) => task.title === "Inspect without review")?.review_policy,
    "off",
  );
  assert.equal(verified.listTasks().length, 3);
  verified.close();
});

test("CLI Task startup and reconciliation share the durable Workspace claim", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-startup-race-"));
  dirs.push(rootDir);
  const repo = path.join(rootDir, "repo");
  const home = path.join(rootDir, "home");
  const bin = path.join(rootDir, "bin");
  const gateStarted = path.join(rootDir, "git-worktree-started");
  const gateRelease = path.join(rootDir, "git-worktree-release");
  const tmuxState = path.join(rootDir, "tmux-state");
  await mkdir(repo);
  await mkdir(bin);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const paths = await ensureSwitchYardHome({ SWITCHYARD_HOME: home });
  const initialStore = new StateStore(paths.database);
  initialStore.db
    .prepare("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p', 'repo', ?, ?)")
    .run(repo, now());
  initialStore.close();

  const realGit = (await exec("which", ["git"])).stdout.trim();
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env bash\nset -e\nif [[ "$1 $2" == "worktree add" ]]; then\n  : > ${JSON.stringify(gateStarted)}\n  while [[ ! -e ${JSON.stringify(gateRelease)} ]]; do sleep 0.01; done\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  await writeFile(
    path.join(bin, "tmux"),
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(tmuxState)}\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window) printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) i=0; while IFS= read -r name; do i=$((i+1)); printf '@%s\\t%s\\n' "$i" "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  kill-window) target="\${3#@}"; temp="$state.tmp"; awk -v target="$target" 'NR != target' "$state" > "$temp"; mv "$temp" "$state" ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(path.join(bin, "git"), 0o755);
  await chmod(path.join(bin, "tmux"), 0o755);
  const env = { ...process.env, SWITCHYARD_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;
  const cliStartup = run(["task", "create", "p", "--json", "Concurrent startup"], env);
  const reconcilerStore = new StateStore(paths.database);

  try {
    await waitForFile(gateStarted);
    const task = reconcilerStore.listTasks()[0];
    assert.ok(task);
    assert.equal(task.state, "starting");
    assert.equal(reconcilerStore.getWorkspace(task.id)?.provisioned, 0);
    assert.notEqual(reconcilerStore.getWorkspace(task.id)?.provisioner_pid, null);
    assert.ok(reconcilerStore.getWorkspace(task.id)?.provisioner_token);
    await reconcile(reconcilerStore, paths);
    assert.equal(reconcilerStore.getTask(task.id)?.state, "starting");
    assert.equal(reconcilerStore.getWorkspace(task.id)?.provisioned, 0);
    assert.equal(reconcilerStore.getLiveWorker(task.id), undefined);
  } finally {
    await writeFile(gateRelease, "release\n");
  }

  const result = await cliStartup;
  assert.equal(result.code, 0, result.stderr);
  const taskId = (JSON.parse(result.stdout) as { task: { id: string } }).task.id;
  assert.ok(taskId);
  assert.equal(reconcilerStore.getTask(taskId)?.state, "running");
  assert.equal(reconcilerStore.getWorkspace(taskId)?.provisioned, 1);
  assert.ok(reconcilerStore.getActiveWorker(taskId));
  assert.equal((await readFile(tmuxState, "utf8")).trim().split(/\r?\n/).length, 1);
  reconcilerStore.close();
});

test("project add rejects all SwitchYard-managed checkouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-managed-project-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const paths = await ensureSwitchYardHome({ SWITCHYARD_HOME: home });
  const env = { ...process.env, SWITCHYARD_HOME: home };

  for (const managedRoot of [paths.sources, paths.reviews, paths.worktrees]) {
    const checkout = path.join(managedRoot, "managed-repo");
    await mkdir(checkout);
    await exec("git", ["init", "-b", "main"], { cwd: checkout });
    const added = await run(["project", "add", checkout], env);
    assert.equal(added.code, 1);
    assert.match(added.stderr, /SwitchYard-managed checkouts cannot be registered/);
  }

  const store = new StateStore(paths.database);
  assert.equal(store.listProjects().length, 0);
  store.close();
});

test("task clean clears durable provisioned state after removing the Workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-clean-state-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });
  const env = { ...process.env, SWITCHYARD_HOME: home };
  const paths = await ensureSwitchYardHome(env);
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, ?)")
    .run(repo, now());
  const task = createTask(store, "p", "implement", "clean this task", "off");
  await startTask(store, paths, task.id);
  const workspace = store.getWorkspace(task.id);
  assert.ok(workspace);
  cancelTask(store, task.id);
  store.close();

  const cleaned = await run(["task", "clean", task.id], env);
  assert.equal(cleaned.code, 0, cleaned.stderr);
  await assert.rejects(access(workspace.path));

  const verified = new StateStore(paths.database);
  assert.equal(verified.getWorkspace(task.id)?.provisioned, 0);
  assert.ok(verified.listEvents(task.id).some((event) => event.type === "workspace.cleaned"));
  verified.close();
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
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, ?)")
    .run(repo, now());
  const task = createTask(store, "p", "implement", "work", "off");
  const workspacePath = path.join(paths.worktrees, "p", task.id);
  const workspace = await createWorkspace(repo, workspacePath, `switchyard/task-${task.id}`);
  store.db
    .prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
    .run(task.id, workspace.path, workspace.branch, now());
  store.db.prepare("UPDATE tasks SET base_sha=? WHERE id=?").run(workspace.baseSha, task.id);
  store.close();

  const cleaned = await run(["task", "clean", task.id], env);
  assert.equal(cleaned.code, 1);
  assert.match(cleaned.stderr, /only terminal Tasks can be cleaned/);
  await access(workspace.path);
});
