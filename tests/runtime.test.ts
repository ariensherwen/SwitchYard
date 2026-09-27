import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { enqueueMessage } from "../src/inbox.ts";
import { beginReview } from "../src/review.ts";
import { resumeReservedWorker, startReviewer, startWorker } from "../src/runtime.ts";
import { now, StateStore } from "../src/state.ts";
import { createTask, markRunning, startTask, submitCandidate } from "../src/tasks.ts";

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
  const failureFile = path.join(root, "fake-tmux-failure");
  await mkdir(bin);
  const tmux = path.join(bin, "tmux");
  await writeFile(
    tmux,
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(stateFile)}\nfailure=${JSON.stringify(failureFile)}\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window)\n    if [[ -f "$failure" ]]; then IFS= read -r failed < "$failure"; [[ "$6" != "$failed" ]] || exit 1; fi\n    printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) while IFS= read -r name; do printf '@1\\t%s\\n' "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  kill-window) : ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(tmux, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  return { paths, store, stateFile, failureFile };
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

test("one Task recovery failure is recorded without blocking later Tasks", async () => {
  const { paths, store, failureFile } = await fixture();
  const laterTask = createTask(store, "p", "implement", "recover later", "off");
  const brokenTask = createTask(store, "p", "implement", "fail recovery", "off");
  await startTask(store, paths, laterTask.id);
  await startTask(store, paths, brokenTask.id);
  store.db
    .prepare("UPDATE tasks SET created_at=? WHERE id=?")
    .run("2030-01-02T00:00:00.000Z", brokenTask.id);
  store.db
    .prepare("UPDATE tasks SET created_at=? WHERE id=?")
    .run("2030-01-01T00:00:00.000Z", laterTask.id);
  await writeFile(failureFile, `task-${brokenTask.id}\n`);
  const { reconcile } = await import("../src/reconcile.ts");

  await reconcile(store, paths);

  assert.equal(store.getTask(brokenTask.id)?.state, "failed");
  assert.match(store.getTask(brokenTask.id)?.failure ?? "", /recovery failed/);
  assert.ok(store.listEvents(brokenTask.id).some((event) => event.type === "task.recovery_failed"));
  assert.equal(store.getTask(laterTask.id)?.state, "running");
  assert.ok(store.getActiveWorker(laterTask.id));
  store.close();
});

test("concurrent Reviewer launches share one durable startup owner", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "review this change", "loop");
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const workspace = store.getWorkspace(task.id);
  assert.ok(workspace);
  await writeFile(path.join(workspace.path, "README.md"), "candidate\n");
  await exec("git", ["add", "README.md"], { cwd: workspace.path });
  await exec("git", ["commit", "-m", "candidate"], { cwd: workspace.path });
  await submitCandidate(store, task.id, "candidate", "verified");
  const reviewId = await beginReview(store, paths, task.id);
  const secondStore = new StateStore(paths.database);

  await Promise.all([
    startReviewer(store, paths, reviewId),
    startReviewer(secondStore, paths, reviewId),
  ]);

  const review = store.getReview(reviewId);
  assert.ok(review);
  assert.equal(review.runtime_starting, 0);
  assert.equal(review.runtime_starter_pid, null);
  assert.equal((await readFile(stateFile, "utf8")).trim().split(/\r?\n/).length, 1);
  assert.equal(
    store.listEvents(task.id).filter((event) => event.type === "reviewer.started").length,
    1,
  );
  secondStore.close();
  store.close();
});
