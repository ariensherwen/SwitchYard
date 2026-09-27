import { randomUUID } from "node:crypto";
import type { SwitchYardPaths } from "./home.ts";
import { buildPiLaunch, shellCommand } from "./pi.ts";
import type { StateStore } from "./state.ts";
import { now } from "./state.ts";
import { markRunning } from "./tasks.ts";
import { ensureWindow, killWindow, sendWake } from "./tmux.ts";

export async function startWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<string> {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (task?.state !== "starting" || !workspace)
    throw new Error("task is not ready to start a worker");
  const workerId = randomUUID();
  const window = `task-${taskId}`;
  const prompt = `You are the SwitchYard Worker for task ${taskId}. Work only in this task workspace. Use SwitchYard lifecycle tools for decisions, waiting, and completion.`;
  const launch = buildPiLaunch(
    "worker",
    workspace.path,
    {
      SWITCHYARD_HOME: paths.home,
      SWITCHYARD_TASK_ID: taskId,
      SWITCHYARD_WORKER_ID: workerId,
    },
    prompt,
  );
  await ensureWindow(window, launch.cwd, shellCommand(launch));
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO workers(id, task_id, state, tmux_window, created_at)
      VALUES (?, ?, 'active', ?, ?)`)
      .run(workerId, taskId, window, now());
    store.event(taskId, "worker.started", { worker_id: workerId, window });
  });
  markRunning(store, taskId);
  return workerId;
}

export async function stopWorker(store: StateStore, taskId: string): Promise<void> {
  const worker = store.getActiveWorker(taskId);
  if (!worker) return;
  await killWindow(worker.tmux_window);
  store.transaction(() => {
    store.db
      .prepare("UPDATE workers SET state='stopped', ended_at=? WHERE id=? AND state='active'")
      .run(now(), worker.id);
    store.event(taskId, "worker.stopped", { worker_id: worker.id });
  });
}

export async function wakeSupervisor(): Promise<void> {
  await sendWake("supervisor");
}

export async function wakeWorker(store: StateStore, taskId: string): Promise<void> {
  const worker = store.getActiveWorker(taskId);
  if (worker) await sendWake(worker.tmux_window);
}

export async function replaceWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<string> {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (task?.state !== "running" || !workspace)
    throw new Error("task is not ready for a replacement Worker");
  const existing = store.getActiveWorker(taskId);
  if (existing) {
    store.db
      .prepare("UPDATE workers SET state='stopped', ended_at=? WHERE id=? AND state='active'")
      .run(now(), existing.id);
  }
  const workerId = randomUUID();
  const window = `task-${taskId}`;
  const prompt = `You are a replacement SwitchYard Worker for task ${taskId}. Continue in the existing task workspace. Inspect durable task context and outstanding review findings before acting.`;
  const launch = buildPiLaunch(
    "worker",
    workspace.path,
    { SWITCHYARD_HOME: paths.home, SWITCHYARD_TASK_ID: taskId, SWITCHYARD_WORKER_ID: workerId },
    prompt,
  );
  await ensureWindow(window, launch.cwd, shellCommand(launch));
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(workerId, taskId, window, now());
    store.event(taskId, "worker.replaced", { worker_id: workerId, window });
  });
  return workerId;
}

export async function startReviewer(
  store: StateStore,
  paths: SwitchYardPaths,
  reviewId: string,
): Promise<void> {
  const review = store.getReview(reviewId);
  if (review?.state !== "running") throw new Error("review is not running");
  const task = store.getTask(review.task_id);
  if (!task?.base_sha) throw new Error("task/base revision not found");
  const prompt = `You are an independent SwitchYard Reviewer for task ${task.id}. Review the entire candidate revision ${review.candidate_sha} against the original instruction. Do not modify the worker workspace. Submit exactly one structured review result with switchyard_submit_review.`;
  const launch = buildPiLaunch(
    "reviewer",
    review.path,
    {
      SWITCHYARD_HOME: paths.home,
      SWITCHYARD_TASK_ID: task.id,
      SWITCHYARD_REVIEW_ID: reviewId,
    },
    prompt,
  );
  await ensureWindow(review.tmux_window, launch.cwd, shellCommand(launch));
  store.event(task.id, "reviewer.started", { review_id: reviewId, window: review.tmux_window });
}
