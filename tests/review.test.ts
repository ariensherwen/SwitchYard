import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { getSwitchYardPaths } from "../src/home.ts";
import { beginReview, submitReview } from "../src/review.ts";
import { StateStore } from "../src/state.ts";
import { completeRecoveredReview, createTask, steerTask, submitCandidate } from "../src/tasks.ts";
import { createWorkspace } from "../src/worktree.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-review-repo-"));
  dirs.push(root);
  await exec("git", ["init", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "a.txt"), "a\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "base"], { cwd: root });
  const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-review-home-"));
  dirs.push(home);
  const paths = getSwitchYardPaths({ ...process.env, SWITCHYARD_HOME: home });
  await Promise.all(
    [paths.worktrees, paths.reviews].map(async (p) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(p, { recursive: true });
    }),
  );
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, datetime('now'))")
    .run(root);
  const task = createTask(store, "p", "implement", "change a", "loop");
  store.db.prepare("UPDATE tasks SET state='starting' WHERE id=?").run(task.id);
  const workspacePath = path.join(paths.worktrees, "p", task.id);
  const ws = await createWorkspace(root, workspacePath, `switchyard/task-${task.id}`);
  store.db
    .prepare(
      "INSERT INTO workspaces(task_id,path,branch,created_at) VALUES (?,?,?,datetime('now'))",
    )
    .run(task.id, ws.path, ws.branch);
  store.db
    .prepare("UPDATE tasks SET state='running', base_sha=? WHERE id=?")
    .run(ws.baseSha, task.id);
  await writeFile(path.join(ws.path, "a.txt"), "changed\n");
  await exec("git", ["add", "."], { cwd: ws.path });
  await exec("git", ["commit", "-m", "change"], { cwd: ws.path });
  await submitCandidate(store, task.id, "changed", "tests pass");
  return { store, paths, taskId: task.id, workspace: ws.path };
}

test("concurrent Review startup shares one durable reservation", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewIds = await Promise.all([
    beginReview(store, paths, taskId),
    beginReview(store, paths, taskId),
  ]);

  assert.equal(reviewIds[0], reviewIds[1]);
  const reviews = store.db
    .prepare("SELECT * FROM reviews WHERE task_id=? AND state='running'")
    .all(taskId);
  assert.equal(reviews.length, 1);
  assert.equal(store.getReview(reviewIds[0] ?? "")?.startup_reserved, 0);
  assert.equal(
    store.listEvents(taskId).filter((event) => event.type === "review.reserved").length,
    1,
  );
  store.close();
});

test("clean review certifies exact candidate and completes task", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  await submitReview(store, reviewId, {
    verdict: "clean",
    summary: "clean",
    reviewed_paths: ["a.txt"],
    findings: [],
  });
  assert.equal(store.getTask(taskId)?.state, "completed");
  assert.equal(store.getReview(reviewId)?.state, "clean");
  store.close();
});

test("recovery completion requires a clean Review for the current candidate", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  const task = store.getTask(taskId);
  assert.ok(task?.candidate_sha);

  assert.throws(
    () => completeRecoveredReview(store, taskId, task.candidate_sha ?? "", reviewId),
    /requires a clean Review/,
  );
  assert.equal(store.getTask(taskId)?.state, "reviewing");

  store.db.prepare("UPDATE reviews SET state='clean' WHERE id=?").run(reviewId);
  assert.equal(completeRecoveredReview(store, taskId, task.candidate_sha, reviewId), true);
  assert.equal(store.getTask(taskId)?.state, "completed");
  store.close();
});

test("steering is rejected during review and cannot be lost on clean completion", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);

  assert.throws(() => steerTask(store, taskId, "please change the design"), /under review/);
  assert.equal(store.listPendingMessages(taskId, "worker").length, 0);

  await submitReview(store, reviewId, {
    verdict: "clean",
    summary: "clean",
    reviewed_paths: ["a.txt"],
    findings: [],
  });
  assert.equal(store.getTask(taskId)?.state, "completed");
  assert.equal(store.listPendingMessages(taskId, "worker").length, 0);
  store.close();
});

test("partial reviewed paths cannot certify clean", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  await assert.rejects(
    () =>
      submitReview(store, reviewId, {
        verdict: "clean",
        summary: "clean",
        reviewed_paths: [],
        findings: [],
      }),
    /exactly cover/,
  );
  assert.equal(store.getTask(taskId)?.state, "reviewing");
  store.close();
});

test("findings return task to running and same SHA cannot be resubmitted", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  await submitReview(store, reviewId, {
    verdict: "changes_requested",
    summary: "fix",
    reviewed_paths: ["a.txt"],
    findings: [
      {
        summary: "problem",
        rationale: "broken",
        required_change: "fix it",
        path: "a.txt",
        line: 1,
      },
    ],
  });
  assert.equal(store.getTask(taskId)?.state, "running");
  assert.equal(store.listFindings(reviewId).length, 1);
  await assert.rejects(() => submitCandidate(store, taskId, "same", "same"), /unchanged/);
  store.close();
});

test("clean certification is stale if Worker Workspace advances", async () => {
  const { store, paths, taskId, workspace } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  await writeFile(path.join(workspace, "b.txt"), "later\n");
  await exec("git", ["add", "."], { cwd: workspace });
  await exec("git", ["commit", "-m", "later"], { cwd: workspace });
  await assert.rejects(
    () =>
      submitReview(store, reviewId, {
        verdict: "clean",
        summary: "clean",
        reviewed_paths: ["a.txt"],
        findings: [],
      }),
    /workspace changed/,
  );
  assert.equal(store.getTask(taskId)?.state, "reviewing");
  store.close();
});

test("modified review checkout cannot certify clean", async () => {
  const { store, paths, taskId } = await fixture();
  const reviewId = await beginReview(store, paths, taskId);
  const review = store.getReview(reviewId);
  assert.ok(review);
  await writeFile(path.join(review.path, "scratch.txt"), "modified\n");
  await assert.rejects(
    () =>
      submitReview(store, reviewId, {
        verdict: "clean",
        summary: "clean",
        reviewed_paths: ["a.txt"],
        findings: [],
      }),
    /review checkout must be clean/,
  );
  assert.equal(store.getTask(taskId)?.state, "reviewing");
  store.close();
});
