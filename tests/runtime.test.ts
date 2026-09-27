import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { enqueueMessage } from "../src/inbox.ts";
import { resumeReservedWorker, startWorker } from "../src/runtime.ts";
import { now, StateStore } from "../src/state.ts";
import { createTask, startTask } from "../src/tasks.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-runtime-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "base\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-m", "base"], { cwd: repo });

  const home = path.join(root, "home");
  const paths = await ensureSwitchYardHome({ ...process.env, SWITCHYARD_HOME: home });
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, ?)")
    .run(repo, now());

  const bin = path.join(root, "bin");
  const stateFile = path.join(root, "fake-tmux-state");
  await mkdir(bin);
  const tmux = path.join(bin, "tmux");
  await writeFile(
    tmux,
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(stateFile)}\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window) printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) while IFS= read -r name; do printf '@1\\t%s\\n' "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  kill-window) : ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(tmux, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  return { paths, store };
}

test("Worker identity is durable and original instruction is queued before runtime activation", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "Implement the requested feature", "off");
  await startTask(store, paths, task.id);
  const workerId = await startWorker(store, paths, task.id);

  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(store.getActiveWorker(task.id)?.id, workerId);
  const messages = store.listPendingMessages(task.id, "worker");
  assert.equal(messages.length, 1);
  const initialMessage = messages[0];
  assert.ok(initialMessage);
  assert.match(initialMessage.text, /Instruction:\nImplement the requested feature/);
  store.close();
});

test("recovery launches the exact reserved Worker identity after crash-before-spawn", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "Resume me", "off");
  await startTask(store, paths, task.id);
  const workerId = "reserved-worker";
  store.db
    .prepare(
      "INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'starting', ?, ?)",
    )
    .run(workerId, task.id, `task-${task.id}`, now());
  enqueueMessage(
    store,
    task.id,
    "worker",
    "Start this SwitchYard Task.\n\nInstruction:\nResume me",
  );

  const worker = store.getLiveWorker(task.id);
  assert.ok(worker);
  await resumeReservedWorker(store, paths, worker);

  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(store.getActiveWorker(task.id)?.id, workerId);
  assert.deepEqual(
    store.listWorkers(task.id).map((row) => row.id),
    [workerId],
  );
  store.close();
});

test("terminal reconciliation retires lingering Worker authority", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "terminal", "off");
  await startTask(store, paths, task.id);
  const workerId = await startWorker(store, paths, task.id);
  store.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(task.id);
  const { reconcile } = await import("../src/reconcile.ts");

  await reconcile(store, paths);

  assert.equal(store.getActiveWorker(task.id), undefined);
  assert.equal(store.listWorkers(task.id).find((row) => row.id === workerId)?.state, "stopped");
  store.close();
});
