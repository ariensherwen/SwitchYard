import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { StateStore } from "../src/state.ts";
import {
  cancelTask,
  createTask,
  failTask,
  markWaiting,
  resumeWaiting,
  transition,
  updateTaskTitle,
} from "../src/tasks.ts";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "switchyard-state-"));
  dirs.push(dir);
  const store = new StateStore(path.join(dir, "switchyard.db"));
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, datetime('now'))")
    .run(dir);
  return store;
}

test("migrations are repeatable and durable", async () => {
  const store = await fixture();
  const fixtureDir = dirs.at(-1);
  assert.ok(fixtureDir);
  const dbPath = path.join(fixtureDir, "switchyard.db");
  createTask(store, "p", "implement", "change x", "off");
  store.close();
  const reopened = new StateStore(dbPath);
  assert.equal(reopened.listTasks().length, 1);
  assert.equal(
    (reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    10,
  );
  reopened.close();
});

test("schema 11 from an additive pre-release build remains readable", async () => {
  const store = await fixture();
  const fixtureDir = dirs.at(-1);
  assert.ok(fixtureDir);
  const dbPath = path.join(fixtureDir, "switchyard.db");
  store.db.exec("PRAGMA user_version = 11");
  store.close();

  const reopened = new StateStore(dbPath);
  assert.equal(
    (reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    11,
  );
  assert.equal(reopened.listAllProjects().length, 1);
  reopened.close();
});

test("schema migration reserves one active Review per candidate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "switchyard-state-v1-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "switchyard.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('implement','investigate')),
      instruction TEXT NOT NULL,
      review_policy TEXT NOT NULL CHECK(review_policy IN ('off','loop')),
      state TEXT NOT NULL,
      base_sha TEXT,
      candidate_sha TEXT,
      summary TEXT,
      verification_summary TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      task_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      question TEXT NOT NULL,
      context TEXT,
      options_json TEXT,
      state TEXT NOT NULL CHECK(state IN ('open','resolved')),
      answer TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      candidate_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','changes_requested','clean','failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      tmux_window TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  legacy
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('legacy-project', ?, ?)")
    .run(dir, "2025-01-01T00:00:00.000Z");
  legacy
    .prepare(`INSERT INTO tasks(
      id, project_id, kind, instruction, review_policy, state, created_at, updated_at
    ) VALUES ('legacy-task', 'legacy-project', 'implement', 'legacy instruction', 'off', 'queued', ?, ?)`)
    .run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  legacy
    .prepare(`INSERT INTO decisions(id, task_id, question, state, created_at)
      VALUES ('legacy-decision', 'legacy-task', 'Legacy question?', 'open', ?)`)
    .run("2025-01-01T00:00:00.000Z");
  legacy
    .prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
    .run("legacy-task", path.join(dir, "workspace"), "legacy-branch", "2025-01-01T00:00:00.000Z");
  legacy
    .prepare(`INSERT INTO reviews(id, task_id, candidate_sha, state, tmux_window, path, created_at)
      VALUES (?, 'task', 'sha', 'running', ?, ?, ?)`)
    .run("old-review", "old-window", "/old", "2025-01-01T00:00:00.000Z");
  legacy
    .prepare(`INSERT INTO reviews(id, task_id, candidate_sha, state, tmux_window, path, created_at)
      VALUES (?, 'task', 'sha', 'running', ?, ?, ?)`)
    .run("new-review", "new-window", "/new", "2025-01-02T00:00:00.000Z");
  legacy.close();

  const store = new StateStore(dbPath);
  assert.equal(store.getProject("legacy-project")?.name, path.basename(dir));
  assert.equal(store.getTask("legacy-task")?.title, "legacy instruction");
  assert.equal(store.getTask("legacy-task")?.project_id, "legacy-project");
  assert.equal(store.getDecision("legacy-decision")?.state, "open");
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(store.getWorkspace("legacy-task")?.provisioned, 1);
  assert.equal(store.getReview("old-review")?.state, "failed");
  assert.equal(store.getReview("new-review")?.state, "running");
  assert.equal(store.listEvents("task")[0]?.type, "review.superseded");
  assert.throws(
    () =>
      store.db
        .prepare(`INSERT INTO reviews(
          id, task_id, candidate_sha, state, attempts, tmux_window, path, created_at
        ) VALUES ('duplicate', 'task', 'sha', 'running', 1, 'duplicate', '/duplicate', '2025')`)
        .run(),
    /UNIQUE constraint failed/,
  );
  store.close();
});

test("Task titles are persisted independently from completion summaries and mutable", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "Implement stable identity", "off");
  store.db.prepare("UPDATE tasks SET summary=? WHERE id=?").run("Completed change", task.id);
  assert.equal(store.getTask(task.id)?.title, "Implement stable identity");

  updateTaskTitle(store, task.id, "Stable task title");
  assert.equal(store.getTask(task.id)?.title, "Stable task title");
  assert.ok(store.listEvents(task.id).some((event) => event.type === "task.title_updated"));
  store.close();
});

test("captured Task base refs cannot be moved", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off", "A task", {
    baseRef: "main",
  });
  assert.throws(
    () => store.db.prepare("UPDATE tasks SET base_ref='release' WHERE id=?").run(task.id),
    /task base ref is immutable/,
  );
  store.close();
});

test("canonical task transitions reject illegal resurrection", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  assert.throws(
    () => transition(store, task.id, "queued", "completed", "bad"),
    /illegal task transition/,
  );
  const cancelled = cancelTask(store, task.id);
  assert.equal(cancelled.state, "cancelled");
  assert.throws(
    () => transition(store, task.id, "cancelled", "running", "bad"),
    /illegal task transition/,
  );
  store.close();
});

test("reviewing Tasks cannot complete without a clean Review of the current candidate", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "review gate", "loop");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  store.db.prepare("UPDATE tasks SET candidate_sha=? WHERE id=?").run("candidate", task.id);
  transition(store, task.id, "running", "reviewing", "task.reviewing");

  assert.throws(
    () => transition(store, task.id, "reviewing", "completed", "task.completed"),
    /requires a clean Review of its current candidate/,
  );
  assert.equal(store.getTask(task.id)?.state, "reviewing");
  store.close();
});

test("compare-and-set rejects stale concurrent transition", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  cancelTask(store, task.id);
  assert.throws(
    () => transition(store, task.id, "running", "reviewing", "task.reviewing"),
    /current state is cancelled/,
  );
  assert.equal(store.getTask(task.id)?.state, "cancelled");
  store.close();
});

test("state transition and event roll back together", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  const beforeEvents = store.listEvents(task.id).length;
  assert.throws(
    () =>
      store.transaction(() => {
        store.db
          .prepare("UPDATE tasks SET state='starting' WHERE id=? AND state='queued'")
          .run(task.id);
        store.event(task.id, "task.starting");
        throw new Error("inject");
      }),
    /inject/,
  );
  assert.equal(store.getTask(task.id)?.state, "queued");
  assert.equal(store.listEvents(task.id).length, beforeEvents);
  store.close();
});

test("waiting and resume transitions commit with their matching Messages", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");

  markWaiting(store, task.id, "blocked on access");
  assert.equal(store.getTask(task.id)?.state, "waiting");
  assert.ok(store.listEvents(task.id).some((event) => event.type === "task.waiting"));
  assert.match(
    store.listPendingMessages(task.id, "supervisor")[0]?.text ?? "",
    /blocked on access/,
  );
  resumeWaiting(store, task.id, "continue after access is granted");
  assert.equal(store.getTask(task.id)?.state, "running");
  assert.ok(store.listEvents(task.id).some((event) => event.type === "task.resumed"));
  assert.match(
    store.listPendingMessages(task.id, "worker")[0]?.text ?? "",
    /continue after access is granted/,
  );
  store.close();
});

test("waiting transition and supervisor notification roll back together", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  store.db.exec(`CREATE TRIGGER reject_message_event BEFORE INSERT ON events
    WHEN NEW.type='message.queued' BEGIN SELECT RAISE(ABORT, 'injected message failure'); END`);

  assert.throws(() => markWaiting(store, task.id, "blocked"), /injected message failure/);
  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "task.waiting"),
    false,
  );
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 0);
  store.close();
});

test("resume transition and required Worker Message roll back together", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  markWaiting(store, task.id, "blocked");
  store.db.exec(`CREATE TRIGGER reject_message_event BEFORE INSERT ON events
    WHEN NEW.type='message.queued' BEGIN SELECT RAISE(ABORT, 'injected message failure'); END`);

  assert.throws(
    () => resumeWaiting(store, task.id, "continue with this"),
    /injected message failure/,
  );
  assert.equal(store.getTask(task.id)?.state, "waiting");
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "task.resumed"),
    false,
  );
  assert.equal(store.listPendingMessages(task.id, "worker").length, 0);
  store.close();
});

test("terminal Tasks cancel open Decisions with a durable Event", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "blocked task", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  const { requestDecision } = await import("../src/tasks.ts");
  const decisionId = requestDecision(store, task.id, "Choose?", undefined, ["a", "b"]);

  cancelTask(store, task.id);

  const decision = store.getDecision(decisionId);
  assert.equal(decision?.state, "cancelled");
  assert.ok(decision?.resolved_at);
  assert.ok(
    store
      .listEvents(task.id)
      .some(
        (event) => event.type === "decision.cancelled" && event.payload_json.includes("cancelled"),
      ),
  );
  assert.equal(store.getOpenDecision(task.id), undefined);
  store.close();
});

test("failing a Task cancels its open Decision", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "failed blocked task", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  const { requestDecision } = await import("../src/tasks.ts");
  const decisionId = requestDecision(store, task.id, "Choose?", undefined, ["a", "b"]);

  failTask(store, task.id, "forced failure");

  assert.equal(store.getTask(task.id)?.state, "failed");
  assert.equal(store.getDecision(decisionId)?.state, "cancelled");
  assert.equal(store.getOpenDecision(task.id), undefined);
  store.close();
});

test("decision resolution atomically resumes and enqueues answer", async () => {
  const store = await fixture();
  const task = createTask(store, "p", "implement", "change x", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  const { requestDecision, resolveDecision } = await import("../src/tasks.ts");
  const decisionId = requestDecision(store, task.id, "Choose?", undefined, ["a", "b"]);
  assert.equal(store.getTask(task.id)?.state, "needs_decision");
  resolveDecision(store, task.id, decisionId, "a");
  assert.equal(store.getTask(task.id)?.state, "running");
  assert.equal(store.getDecision(decisionId)?.state, "resolved");
  assert.match(store.listPendingMessages(task.id, "worker")[0]?.text ?? "", /answered: a/);
  store.close();
});
