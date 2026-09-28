import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ensureSwitchYardHome } from "../src/home.ts";
import { enqueueMessage } from "../src/inbox.ts";
import { beginReview } from "../src/review.ts";
import {
  quiesceTaskRuntimes,
  replaceWorker,
  resumeReservedWorker,
  startReviewer,
  startWorker,
  wakeWorker,
} from "../src/runtime.ts";
import { now, StateStore } from "../src/state.ts";
import {
  cancelTask,
  createTask,
  createTransientInvestigation,
  failTask,
  markRunning,
  markWaiting,
  requestDecision,
  resolveDecision,
  startTask,
  steerTask,
  submitCandidate,
} from "../src/tasks.ts";
import { windowAlive } from "../src/tmux.ts";

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
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(stateFile)}\nfailure=${JSON.stringify(failureFile)}\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window)\n    if [[ -f "$failure" ]]; then IFS= read -r failed < "$failure"; [[ "$6" != "$failed" ]] || exit 1; fi\n    printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) i=0; while IFS= read -r name; do i=$((i+1)); printf '@%s\\t%s\\n' "$i" "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  kill-window) target="\${3#@}"; temp="$state.tmp"; awk -v target="$target" 'NR != target' "$state" > "$temp"; mv "$temp" "$state" ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(tmux, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  return { paths, store, stateFile, failureFile };
}

test("transient investigation uses a cloned source without registering a Project", async () => {
  const { paths, store } = await fixture();
  const sourceUrl = pathToFileURL(path.join(path.dirname(paths.home), "repo")).href;
  const task = createTransientInvestigation(store, paths, sourceUrl, "Inspect the remote source");

  await startTask(store, paths, task.id);

  const stored = store.getTask(task.id);
  const workspace = store.getWorkspace(task.id);
  assert.equal(stored?.project_id, null);
  assert.equal(stored?.source_url, sourceUrl);
  assert.equal(stored?.kind, "investigate");
  assert.equal(store.listProjects().length, 1);
  assert.equal(workspace?.provisioned, 1);
  assert.ok(workspace?.path.startsWith(path.join(paths.worktrees, "transient")));
  assert.ok(stored?.source_path && existsSync(stored.source_path));
  store.close();
});

test("replacement reservation cannot cross cancellation on another StateStore connection", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "cancel before replacement reservation", "off");
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const cancellingStore = new StateStore(paths.database);

  await assert.rejects(
    replaceWorker(store, paths, task.id, {
      afterTaskCheck: () => cancelTask(cancellingStore, task.id),
    }),
    /expected running/,
  );
  assert.equal(store.getTask(task.id)?.state, "cancelled");
  assert.equal(store.getLiveWorker(task.id), undefined);
  assert.equal(store.listWorkers(task.id).length, 0);
  cancellingStore.close();
  store.close();
});

test("replacement activation cannot cross cancellation on another StateStore connection", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "cancel before replacement activation", "off");
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const cancellingStore = new StateStore(paths.database);

  await assert.rejects(
    replaceWorker(store, paths, task.id, {
      afterReservation: async () => {
        cancelTask(cancellingStore, task.id);
        await quiesceTaskRuntimes(cancellingStore, task.id);
      },
    }),
    /cannot activate replacement Worker while task is cancelled/,
  );
  assert.equal(store.getTask(task.id)?.state, "cancelled");
  assert.equal(store.getLiveWorker(task.id), undefined);
  assert.equal(store.listWorkers(task.id)[0]?.state, "stopped");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "");
  cancellingStore.close();
  store.close();
});

test("resuming a waiting Task replaces its dead Worker before returning", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "resume after worker death", "off");
  await startTask(store, paths, task.id);
  const originalWorkerId = await startWorker(store, paths, task.id);
  markWaiting(store, task.id, "waiting for guidance");
  await rm(stateFile, { force: true });

  steerTask(store, task.id, "Continue now");
  await wakeWorker(store, paths, task.id);

  const replacement = store.getActiveWorker(task.id);
  assert.equal(store.getTask(task.id)?.state, "running");
  assert.ok(replacement);
  assert.notEqual(replacement.id, originalWorkerId);
  assert.equal(
    store.listWorkers(task.id).find((worker) => worker.id === originalWorkerId)?.state,
    "stopped",
  );
  assert.ok(
    store
      .listPendingMessages(task.id, "worker")
      .some((message) => /Continue now/.test(message.text)),
  );
  store.close();
});

test("answering a Decision replaces its dead Worker before returning", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "resume after answer", "off");
  await startTask(store, paths, task.id);
  const originalWorkerId = await startWorker(store, paths, task.id);
  const decisionId = requestDecision(store, task.id, "Choose?", undefined, ["a", "b"]);
  await rm(stateFile, { force: true });

  resolveDecision(store, task.id, decisionId, "a");
  await wakeWorker(store, paths, task.id);

  const replacement = store.getActiveWorker(task.id);
  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(store.getDecision(decisionId)?.state, "resolved");
  assert.ok(replacement);
  assert.notEqual(replacement.id, originalWorkerId);
  assert.ok(
    store
      .listPendingMessages(task.id, "worker")
      .some((message) => /answered: a/.test(message.text)),
  );
  store.close();
});

test("reserved Worker recovery does not launch a terminal Task", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "cancel before resume", "off");
  await startTask(store, paths, task.id);
  const workerId = "cancelled-reserved-worker";
  store.db
    .prepare(
      "INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'starting', ?, ?)",
    )
    .run(workerId, task.id, `task-${task.id}`, now());
  const worker = store.getLiveWorker(task.id);
  assert.ok(worker);
  const cancellingStore = new StateStore(paths.database);
  cancelTask(cancellingStore, task.id);

  await assert.rejects(resumeReservedWorker(store, paths, worker), /task is cancelled/);

  assert.equal(existsSync(stateFile), false);
  assert.equal(store.getTask(task.id)?.state, "cancelled");
  assert.equal(store.listWorkers(task.id)[0]?.state, "stopped");
  cancellingStore.close();
  store.close();
});

test("reserved Worker recovery cleans up when cancellation wins after launch", async () => {
  const { paths, store, stateFile } = await fixture();
  const task = createTask(store, "p", "implement", "cancel after resume launch", "off");
  await startTask(store, paths, task.id);
  markRunning(store, task.id);
  const workerId = "racing-reserved-worker";
  store.db
    .prepare(
      "INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'starting', ?, ?)",
    )
    .run(workerId, task.id, `task-${task.id}`, now());
  const worker = store.getLiveWorker(task.id);
  assert.ok(worker);
  const cancellingStore = new StateStore(paths.database);

  await assert.rejects(
    resumeReservedWorker(store, paths, worker, {
      afterLaunch: () => cancelTask(cancellingStore, task.id),
    }),
    /cannot activate reserved Worker while task is cancelled/,
  );

  assert.equal(store.getTask(task.id)?.state, "cancelled");
  assert.equal(store.listWorkers(task.id)[0]?.state, "stopped");
  assert.equal((await readFile(stateFile, "utf8")).trim(), "");
  cancellingStore.close();
  store.close();
});

test("recovery starts a Task left queued by a crash after creation", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "queued recovery", "off");
  const { reconcile } = await import("../src/reconcile.ts");

  await reconcile(store, paths);

  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(store.getWorkspace(task.id)?.provisioned, 1);
  assert.ok(store.getActiveWorker(task.id));
  assert.ok(store.listEvents(task.id).some((event) => event.type === "workspace.reserved"));
  store.close();
});

test("recovery provisions a reserved Workspace after a crash before git worktree add", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "reserved recovery", "off");
  await assert.rejects(
    () =>
      startTask(store, paths, task.id, {
        afterReservation: () => {
          throw new Error("injected crash");
        },
      }),
    /injected crash/,
  );
  const reservation = store.getWorkspace(task.id);
  assert.equal(store.getTask(task.id)?.state, "starting");
  assert.equal(reservation?.provisioned, 0);
  assert.equal(reservation ? existsSync(reservation.path) : true, false);
  store.close();

  const recovered = new StateStore(paths.database);
  const { reconcile } = await import("../src/reconcile.ts");
  await reconcile(recovered, paths);

  assert.equal(recovered.getTask(task.id)?.state, "running");
  assert.equal(recovered.getWorkspace(task.id)?.provisioned, 1);
  assert.ok(recovered.getActiveWorker(task.id));
  recovered.close();
});

test("recovery adopts a created Workspace after a crash before readiness persistence", async () => {
  const { paths, store } = await fixture();
  const task = createTask(store, "p", "implement", "created worktree recovery", "off");
  await assert.rejects(
    () =>
      startTask(store, paths, task.id, {
        afterWorktreeProvisioned: () => {
          throw new Error("injected crash");
        },
      }),
    /injected crash/,
  );
  const reservation = store.getWorkspace(task.id);
  assert.equal(store.getTask(task.id)?.state, "starting");
  assert.equal(reservation?.provisioned, 0);
  assert.equal(reservation ? existsSync(reservation.path) : false, true);
  store.close();

  const recovered = new StateStore(paths.database);
  const { reconcile } = await import("../src/reconcile.ts");
  await reconcile(recovered, paths);

  assert.equal(recovered.getTask(task.id)?.state, "running");
  assert.equal(recovered.getWorkspace(task.id)?.provisioned, 1);
  assert.ok(recovered.getActiveWorker(task.id));
  const worktrees = (
    await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: path.join(path.dirname(paths.home), "repo"),
    })
  ).stdout;
  assert.equal(worktrees.match(/worktree /g)?.length, 2);
  recovered.close();
});

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

test("cancelling or failing during review aborts the Review and removes its worktree", async (t) => {
  for (const terminal of ["cancelled", "failed"] as const) {
    await t.test(terminal, async () => {
      const { paths, store } = await fixture();
      const task = createTask(store, "p", "implement", `terminate review ${terminal}`, "loop");
      await startTask(store, paths, task.id);
      markRunning(store, task.id);
      const workspace = store.getWorkspace(task.id);
      assert.ok(workspace);
      await writeFile(path.join(workspace.path, "README.md"), "candidate\n");
      await exec("git", ["add", "README.md"], { cwd: workspace.path });
      await exec("git", ["commit", "-m", "candidate"], { cwd: workspace.path });
      await submitCandidate(store, task.id, "candidate", "verified");
      const reviewId = await beginReview(store, paths, task.id);
      await startReviewer(store, paths, reviewId);
      const review = store.getReview(reviewId);
      assert.ok(review);
      assert.equal(review.state, "running");

      if (terminal === "cancelled") cancelTask(store, task.id);
      else failTask(store, task.id, "forced failure during review");
      await quiesceTaskRuntimes(store, task.id);

      assert.equal(store.getTask(task.id)?.state, terminal);
      assert.equal(store.getReview(reviewId)?.state, "failed");
      assert.match(store.getReview(reviewId)?.summary ?? "", /Review aborted/);
      assert.ok(store.listEvents(task.id).some((event) => event.type === "review.aborted"));
      assert.ok(store.listEvents(task.id).some((event) => event.type === "review.runtime_cleaned"));
      assert.equal(await windowAlive(review.tmux_window), false);
      assert.equal(existsSync(review.path), false);
      store.close();
    });
  }
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
