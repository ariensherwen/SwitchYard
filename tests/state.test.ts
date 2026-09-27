import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { StateStore } from "../src/state.ts";
import { cancelTask, createTask, transition } from "../src/tasks.ts";

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
  const dbPath = path.join(dirs[dirs.length - 1]!, "switchyard.db");
  createTask(store, "p", "implement", "change x", "off");
  store.close();
  const reopened = new StateStore(dbPath);
  assert.equal(reopened.listTasks().length, 1);
  assert.equal(
    (reopened.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    1,
  );
  reopened.close();
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
