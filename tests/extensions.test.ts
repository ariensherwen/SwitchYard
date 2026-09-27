import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { PiExtensionApi, PiLifecycleEvent, PiToolDefinition } from "../extensions/pi-types.ts";
import reviewerExtension from "../extensions/reviewer.ts";
import supervisorExtension from "../extensions/supervisor.ts";
import workerExtension from "../extensions/worker.ts";
import { ensureSwitchYardHome } from "../src/home.ts";
import { enqueueMessage, signalWake } from "../src/inbox.ts";
import { now, StateStore } from "../src/state.ts";
import { createTask, transition } from "../src/tasks.ts";

const dirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...savedEnv };
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(state: "running" | "waiting" = "running") {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-ext-"));
  dirs.push(root);
  const paths = await ensureSwitchYardHome({
    ...process.env,
    SWITCHYARD_HOME: path.join(root, "home"),
  });
  process.env.SWITCHYARD_HOME = paths.home;
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, root_path, created_at) VALUES ('p', ?, ?)")
    .run(root, now());
  const task = createTask(store, "p", "implement", "Do the durable instruction", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  if (state === "waiting") transition(store, task.id, "running", "waiting", "task.waiting");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  store.db
    .prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
    .run(task.id, workspace, `switchyard/task-${task.id}`, now());
  const workerId = "worker-1";
  store.db
    .prepare(
      "INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run(workerId, task.id, `task-${task.id}`, now());
  return { paths, store, taskId: task.id, workerId };
}

function fakePi() {
  const tools = new Map<string, unknown>();
  const handlers = new Map<PiLifecycleEvent, Parameters<PiExtensionApi["on"]>[1]>();
  const messages: Array<{ text: string; options: unknown }> = [];
  const activeTools: string[][] = [];
  const api: PiExtensionApi = {
    registerTool<TParams>(tool: PiToolDefinition<TParams>) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    async sendUserMessage(text, options) {
      messages.push({ text, options });
    },
    setActiveTools(names) {
      activeTools.push([...names]);
    },
  };
  return {
    api,
    getTool<TParams>(name: string) {
      return tools.get(name) as PiToolDefinition<TParams> | undefined;
    },
    handlers,
    messages,
    activeTools,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for condition");
}

test("idle Worker receives durable startup and wake-driven steering as Pi user messages", async () => {
  const { paths, store, taskId, workerId } = await fixture();
  process.env.SWITCHYARD_TASK_ID = taskId;
  process.env.SWITCHYARD_WORKER_ID = workerId;
  enqueueMessage(store, taskId, "worker", "Original Task instruction");
  const fake = fakePi();
  workerExtension(fake.api);

  await fake.handlers.get("session_start")?.();
  assert.equal(fake.messages.length, 1);
  const initialMessage = fake.messages[0];
  assert.ok(initialMessage);
  assert.match(initialMessage.text, /Original Task instruction/);
  assert.deepEqual(initialMessage.options, { deliverAs: "steer" });
  const enabledTools = fake.activeTools.at(-1);
  assert.ok(enabledTools);
  assert.ok(enabledTools.includes("bash"));

  enqueueMessage(store, taskId, "worker", "Steer the idle Worker");
  await signalWake(paths.wake, `worker-${workerId}.wake`);
  await waitFor(() => fake.messages.length === 2);
  const steeringMessage = fake.messages[1];
  assert.ok(steeringMessage);
  assert.match(steeringMessage.text, /Steer the idle Worker/);
  assert.equal(store.listPendingMessages(taskId, "worker").length, 0);

  await fake.handlers.get("session_shutdown")?.();
  store.close();
});

test("Reviewer receives an initial review request as a Pi user message", async () => {
  process.env.SWITCHYARD_REVIEW_ID = "review-1";
  const fake = fakePi();
  reviewerExtension(fake.api);

  await fake.handlers.get("session_start")?.();

  assert.deepEqual(fake.activeTools.at(-1), ["read", "switchyard_submit_review"]);
  const initialMessage = fake.messages[0];
  assert.ok(initialMessage);
  assert.match(initialMessage.text, /Begin the independent review/);
  assert.deepEqual(initialMessage.options, { deliverAs: "steer" });
});

test("Supervisor steering resumes a waiting Task through the shared domain operation", async () => {
  const { store, taskId } = await fixture("waiting");
  const fake = fakePi();
  supervisorExtension(fake.api);
  const tool = fake.getTool<{ task_id: string; text: string }>("switchyard_send_message");
  assert.ok(tool);

  await tool.execute("call", { task_id: taskId, text: "Resume with this guidance" });

  assert.equal(store.getTask(taskId)?.state, "running");
  assert.match(
    store.listPendingMessages(taskId, "worker")[0]?.text ?? "",
    /Resume with this guidance/,
  );
  store.close();
});

test("Supervisor and Reviewer authority is mechanically allowlisted", async () => {
  const supervisor = fakePi();
  supervisorExtension(supervisor.api);
  // The allowlist is applied on session_start; use an empty durable home.
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-role-"));
  dirs.push(root);
  process.env.SWITCHYARD_HOME = path.join(root, "home");
  await supervisor.handlers.get("session_start")?.();
  const active = supervisor.activeTools.at(-1);
  assert.ok(active);
  assert.deepEqual(
    active.sort(),
    [
      "switchyard_cancel_task",
      "switchyard_delegate",
      "switchyard_get_task",
      "switchyard_list_tasks",
      "switchyard_resolve_decision",
      "switchyard_send_message",
    ].sort(),
  );
  assert.equal(active.includes("bash"), false);
  assert.equal(active.includes("edit"), false);
  await supervisor.handlers.get("session_shutdown")?.();
});
