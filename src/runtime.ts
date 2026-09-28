import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SwitchYardPaths } from "./home.ts";
import { enqueueMessage, signalWake } from "./inbox.ts";
import { buildPiLaunch, shellCommand } from "./pi.ts";
import type { StateStore, WorkerRecord } from "./state.ts";
import { now } from "./state.ts";
import {
  casTransition,
  cleanupTerminalTransientTask,
  taskSourceRoot,
  terminateActiveReviews,
} from "./tasks.ts";
import { ensureWindow, killWindow, taskWindowName, windowAlive } from "./tmux.ts";
import { removeWorktree } from "./worktree.ts";

export async function startWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
  hooks: WorkerResumeHooks = {},
): Promise<string> {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (workspace?.provisioned !== 1)
    throw new Error("task workspace is not ready to start a worker");
  if (task?.state === "running") {
    await wakeWorker(store, paths, taskId);
    const live = store.getLiveWorker(taskId);
    if (live) return live.id;
    throw new Error("running Task has no live Worker after startup adoption");
  }
  if (task?.state !== "starting") throw new Error("task is not ready to start a worker");

  let worker = store.getLiveWorker(taskId);
  if (worker?.state === "active") {
    if (await windowAlive(worker.tmux_window)) {
      if (store.getTask(taskId)?.state === "starting")
        activateWorkerAndTask(store, taskId, worker.id);
      return worker.id;
    }
    retireWorker(store, taskId, worker.id, "startup runtime disappeared");
    worker = undefined;
  }
  const reservation = worker ? { worker, created: false } : reserveWorker(store, taskId, false);
  worker = reservation.worker;
  if (worker.state === "active") {
    if (await windowAlive(worker.tmux_window)) return worker.id;
    retireWorker(store, taskId, worker.id, "startup runtime disappeared");
    return replaceWorker(store, paths, taskId);
  }
  await resumeReservedWorker(store, paths, worker, hooks);
  return worker.id;
}

export interface WorkerReplacementHooks {
  afterTaskCheck?: () => void | Promise<void>;
  afterReservation?: () => void | Promise<void>;
}

export interface WorkerResumeHooks {
  afterClaim?: () => void | Promise<void>;
  afterLaunch?: () => void | Promise<void>;
}

export async function replaceWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
  hooks: WorkerReplacementHooks = {},
): Promise<string> {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (task?.state !== "running" || workspace?.provisioned !== 1) {
    throw new Error("task is not ready for a replacement Worker");
  }
  await hooks.afterTaskCheck?.();

  const live = store.getLiveWorker(taskId);
  if (live?.state === "starting") {
    await resumeReservedWorker(store, paths, live);
    return live.id;
  }
  if (live?.state === "active") {
    if (await windowAlive(live.tmux_window)) return live.id;
    retireWorker(store, taskId, live.id, "worker runtime disappeared");
  }

  const reservation = reserveWorker(store, taskId, true);
  if (reservation.created) await hooks.afterReservation?.();
  const currentTask = store.getTask(taskId);
  if (currentTask?.state !== "running") {
    await cleanupFailedReservedWorker(store, reservation.worker);
    throw new Error(
      `cannot activate replacement Worker while task is ${currentTask?.state ?? "missing"}`,
    );
  }
  if (reservation.worker.state === "active") {
    if (await windowAlive(reservation.worker.tmux_window)) return reservation.worker.id;
    retireWorker(store, taskId, reservation.worker.id, "worker runtime disappeared");
    return replaceWorker(store, paths, taskId);
  }
  await resumeReservedWorker(store, paths, reservation.worker);
  return reservation.worker.id;
}

export async function resumeReservedWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  worker: WorkerRecord,
  hooks: WorkerResumeHooks = {},
): Promise<void> {
  if (worker.state !== "starting") throw new Error("worker is not reserved for startup");
  const task = store.getTask(worker.task_id);
  const reservedWorker = store.getLiveWorker(worker.task_id);
  if (
    task?.state === "running" &&
    reservedWorker?.id === worker.id &&
    reservedWorker.state === "active"
  )
    return;
  if (!task || !["starting", "running"].includes(task.state)) {
    await cleanupFailedReservedWorker(
      store,
      reservedWorker?.id === worker.id ? reservedWorker : worker,
    );
    throw new Error(`cannot activate reserved Worker while task is ${task?.state ?? "missing"}`);
  }
  if (reservedWorker?.id !== worker.id) return;
  if (reservedWorker.state === "active") return;
  if (reservedWorker.state !== "starting") return;

  const startupToken = claimWorkerStartup(store, worker.task_id, worker.id);
  if (!startupToken) {
    const currentTask = store.getTask(worker.task_id);
    const currentWorker = store.getLiveWorker(worker.task_id);
    if (!currentTask || !["starting", "running"].includes(currentTask.state)) {
      await cleanupFailedReservedWorker(
        store,
        currentWorker?.id === worker.id ? currentWorker : worker,
      );
      throw new Error(
        `cannot activate reserved Worker while task is ${currentTask?.state ?? "missing"}`,
      );
    }
    if (
      currentWorker?.id === worker.id &&
      (currentWorker.state === "active" ||
        (currentWorker.runtime_starting === 1 && processIsAlive(currentWorker.runtime_starter_pid)))
    )
      return;
    return;
  }

  try {
    await hooks.afterClaim?.();
    assertWorkerStartupClaim(store, worker.task_id, worker.id, startupToken);
    await launchReservedWorker(store, paths, reservedWorker);
    await hooks.afterLaunch?.();
    const currentTask = store.getTask(worker.task_id);
    if (currentTask?.state === "starting")
      activateWorkerAndTask(store, currentTask.id, worker.id, startupToken);
    else if (currentTask?.state === "running")
      activateReservedWorker(store, currentTask.id, worker.id, startupToken);
    else
      throw new Error(
        `cannot activate reserved Worker while task is ${currentTask?.state ?? "missing"}`,
      );
  } catch (error) {
    await cleanupFailedReservedWorker(store, reservedWorker);
    throw error;
  }
}

function claimWorkerStartup(
  store: StateStore,
  taskId: string,
  workerId: string,
): string | undefined {
  return store.transaction(() => {
    const task = store.getTask(taskId);
    const worker = store.getLiveWorker(taskId);
    if (!task || !["starting", "running"].includes(task.state)) return undefined;
    if (worker?.id !== workerId || worker.state !== "starting") return undefined;
    if (worker.runtime_starting === 1) {
      if (processIsAlive(worker.runtime_starter_pid)) return undefined;
      store.db
        .prepare(`UPDATE workers SET runtime_starting=0, runtime_starter_pid=NULL,
          runtime_startup_token=NULL WHERE id=? AND state='starting' AND runtime_starting=1`)
        .run(workerId);
    }
    const token = randomUUID();
    const changed = store.db
      .prepare(`UPDATE workers SET runtime_starting=1, runtime_starter_pid=?, runtime_startup_token=?
        WHERE id=? AND task_id=? AND state='starting' AND runtime_starting=0`)
      .run(process.pid, token, workerId, taskId);
    return changed.changes === 1 ? token : undefined;
  });
}

function assertWorkerStartupClaim(
  store: StateStore,
  taskId: string,
  workerId: string,
  token: string,
): void {
  const task = store.getTask(taskId);
  const worker = store.getLiveWorker(taskId);
  if (
    !task ||
    !["starting", "running"].includes(task.state) ||
    worker?.id !== workerId ||
    worker.state !== "starting" ||
    worker.runtime_starting !== 1 ||
    worker.runtime_startup_token !== token
  ) {
    throw new Error("reserved Worker startup claim was lost");
  }
}

async function cleanupFailedReservedWorker(store: StateStore, worker: WorkerRecord): Promise<void> {
  const task = store.getTask(worker.task_id);
  const liveWorker = store.getLiveWorker(worker.task_id);
  if (task?.state === "running" && liveWorker?.id === worker.id && liveWorker.state === "active") {
    return;
  }
  if (!liveWorker || liveWorker.id === worker.id) {
    await killWindow(worker.tmux_window);
    retireWorker(store, worker.task_id, worker.id, "reserved Worker recovery failed");
  }
}

function reserveWorker(
  store: StateStore,
  taskId: string,
  replacement: boolean,
): { worker: WorkerRecord; created: boolean } {
  const workerId = randomUUID();
  const taskForName = store.getTask(taskId);
  if (!taskForName) throw new Error(`task not found: ${taskId}`);
  const projectForName = taskForName.project_id ? store.getProject(taskForName.project_id) : undefined;
  const window = taskWindowName(
    "worker",
    projectForName?.name ?? taskForName.source_label ?? "transient",
    taskForName.title,
    taskForName.id,
  );
  let created = false;
  store.transaction(() => {
    const task = store.getTask(taskId);
    const expectedState = replacement ? "running" : "starting";
    const stateCanAdopt = !replacement && task?.state === "running";
    if (task?.state !== expectedState && !stateCanAdopt) {
      throw new Error(`task ${taskId} is ${task?.state ?? "missing"}, expected ${expectedState}`);
    }
    if (store.getLiveWorker(taskId)) return;
    const isReplacement = replacement || stateCanAdopt;
    store.db
      .prepare(
        `INSERT INTO workers(id, task_id, state, tmux_window, created_at)
         VALUES (?, ?, 'starting', ?, ?)`,
      )
      .run(workerId, taskId, window, now());
    store.event(taskId, "worker.reserved", {
      worker_id: workerId,
      window,
      replacement: isReplacement,
    });
    enqueueMessage(
      store,
      taskId,
      "worker",
      buildWorkerDispatchContext(store, taskId, isReplacement),
    );
    created = true;
  });
  const worker = store.getLiveWorker(taskId);
  if (!worker) throw new Error("failed to reserve Worker identity");
  return { worker, created };
}

async function launchReservedWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  worker: WorkerRecord,
): Promise<void> {
  const workspace = store.getWorkspace(worker.task_id);
  const task = store.getTask(worker.task_id);
  if (!task) throw new Error("worker Task is missing");
  if (workspace?.provisioned !== 1) throw new Error("worker workspace is not ready");
  const prompt =
    `You are the SwitchYard Worker for task ${worker.task_id}. ` +
    (task.kind === "investigate"
      ? "Inspect only. This is a read-only investigation: do not modify files or create commits. "
      : "Work only in this task Workspace. ") +
    "The durable Task instruction/context arrives as Pi user input. " +
    "Use SwitchYard lifecycle tools for decisions, waiting, and completion.";
  const launch = buildPiLaunch(
    "worker",
    workspace.path,
    {
      SWITCHYARD_HOME: paths.home,
      SWITCHYARD_TASK_ID: worker.task_id,
      SWITCHYARD_WORKER_ID: worker.id,
    },
    prompt,
  );
  await ensureWindow(worker.tmux_window, launch.cwd, shellCommand(launch));
  if (!(await windowAlive(worker.tmux_window))) throw new Error("Pi Worker exited during startup");
}

function activateWorkerAndTask(
  store: StateStore,
  taskId: string,
  workerId: string,
  startupToken?: string,
): void {
  store.transaction(() => {
    const worker = startupToken
      ? store.db
          .prepare(`UPDATE workers SET state='active', runtime_starting=0, runtime_starter_pid=NULL,
            runtime_startup_token=NULL WHERE id=? AND task_id=? AND state='starting'
            AND runtime_starting=1 AND runtime_startup_token=?`)
          .run(workerId, taskId, startupToken)
      : store.db
          .prepare(
            "UPDATE workers SET state='active' WHERE id=? AND task_id=? AND state IN ('starting','active')",
          )
          .run(workerId, taskId);
    if (worker.changes !== 1) throw new Error("reserved Worker identity is no longer live");
    casTransition(store, taskId, "starting", "running");
    store.event(taskId, "worker.started", { worker_id: workerId });
    store.event(taskId, "task.started", { worker_id: workerId });
    enqueueMessage(store, taskId, "supervisor", "Work started.");
  });
}

function activateReservedWorker(
  store: StateStore,
  taskId: string,
  workerId: string,
  startupToken: string,
): void {
  store.transaction(() => {
    const task = store.getTask(taskId);
    if (task?.state !== "running") {
      throw new Error(`cannot activate reserved Worker while task is ${task?.state ?? "missing"}`);
    }
    const changed = store.db
      .prepare(`UPDATE workers SET state='active', runtime_starting=0, runtime_starter_pid=NULL,
        runtime_startup_token=NULL WHERE id=? AND task_id=? AND state='starting'
        AND runtime_starting=1 AND runtime_startup_token=?`)
      .run(workerId, taskId, startupToken);
    if (changed.changes !== 1) throw new Error("reserved Worker startup claim was lost");
    store.event(taskId, "worker.started", { worker_id: workerId, replacement: true });
  });
}

export async function stopWorker(store: StateStore, taskId: string): Promise<void> {
  const worker = store.getLiveWorker(taskId);
  if (!worker) return;
  await killWindow(worker.tmux_window);
  retireWorker(store, taskId, worker.id, "runtime stopped");
}

export function retireWorker(
  store: StateStore,
  taskId: string,
  workerId: string,
  reason = "runtime retired",
): void {
  store.transaction(() => {
    const changed = store.db
      .prepare(
        `UPDATE workers SET state='stopped', ended_at=?, runtime_starting=0,
          runtime_starter_pid=NULL, runtime_startup_token=NULL
          WHERE id=? AND task_id=? AND state IN ('starting','active')`,
      )
      .run(now(), workerId, taskId);
    if (changed.changes === 1)
      store.event(taskId, "worker.stopped", { worker_id: workerId, reason });
  });
}

export async function stopReviewer(store: StateStore, taskId: string): Promise<void> {
  const review = store.getLatestReview(taskId);
  if (review?.state !== "running") return;
  await killWindow(review.tmux_window);
  store.event(taskId, "reviewer.stopped", { review_id: review.id });
}

export async function quiesceTaskRuntimes(
  store: StateStore,
  taskId: string,
  options: { keepReviewId?: string } = {},
  paths?: SwitchYardPaths,
): Promise<void> {
  await stopWorker(store, taskId);
  const task = store.getTask(taskId);
  if (task && ["completed", "failed", "cancelled"].includes(task.state)) {
    store.transaction(() =>
      terminateActiveReviews(store, taskId, task.state as "completed" | "failed" | "cancelled"),
    );
  }
  for (const review of store.listReviews(taskId)) {
    if (review.id === options.keepReviewId) continue;
    if (review.state === "running") {
      await killWindow(review.tmux_window);
      store.event(taskId, "reviewer.stopped", { review_id: review.id });
    } else {
      await cleanupFinishedReviewRuntime(store, review.id);
    }
  }
  if (task && paths && ["completed", "failed", "cancelled"].includes(task.state)) {
    await cleanupTerminalTransientTask(store, paths, taskId);
  }
}

export async function cleanupFinishedReviewRuntime(
  store: StateStore,
  reviewId: string,
): Promise<void> {
  const review = store.getReview(reviewId);
  if (!review || review.state === "running") return;
  await killWindow(review.tmux_window);
  if (!existsSync(review.path)) return;
  const task = store.getTask(review.task_id);
  if (!task) return;
  try {
    await removeWorktree(taskSourceRoot(store, task), review.path);
    store.event(review.task_id, "review.runtime_cleaned", { review_id: review.id });
  } catch (error) {
    store.event(review.task_id, "review.cleanup_failed", {
      review_id: review.id,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function wakeSupervisor(paths: SwitchYardPaths): Promise<void> {
  await signalWake(paths.wake, "supervisor.wake");
}

export async function wakeWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<void> {
  if (store.getTask(taskId)?.state !== "running") return;
  const worker = store.getLiveWorker(taskId);
  if (worker?.state === "starting") {
    await resumeReservedWorker(store, paths, worker);
  } else if (!worker || !(await windowAlive(worker.tmux_window))) {
    await replaceWorker(store, paths, taskId);
  }
  const activeWorker = store.getActiveWorker(taskId);
  if (activeWorker) await signalWake(paths.wake, `worker-${activeWorker.id}.wake`);
}

export interface ReviewerStartupHooks {
  beforeLaunch?: () => void | Promise<void>;
  afterLaunch?: () => void | Promise<void>;
}

export async function startReviewer(
  store: StateStore,
  paths: SwitchYardPaths,
  reviewId: string,
  hooks: ReviewerStartupHooks = {},
): Promise<void> {
  const review = store.getReview(reviewId);
  if (review?.state !== "running") throw new Error("review is not running");
  if (review.startup_reserved) throw new Error("Review worktree startup is not complete");
  const initialTask = store.getTask(review.task_id);
  if (initialTask?.state !== "reviewing" || initialTask.candidate_sha !== review.candidate_sha)
    throw new Error("Task is no longer ready for Reviewer startup");

  if (await windowAlive(review.tmux_window)) {
    if (review.runtime_starting && !processIsAlive(review.runtime_starter_pid)) {
      clearReviewerStartupClaim(store, reviewId, review.runtime_startup_token);
    }
    return;
  }

  let startupToken: string | undefined;
  store.transaction(() => {
    const current = store.getReview(reviewId);
    const task = store.getTask(review.task_id);
    if (
      current?.state !== "running" ||
      current.startup_reserved ||
      task?.state !== "reviewing" ||
      task.candidate_sha !== current.candidate_sha
    )
      return;
    if (current.runtime_starting) {
      if (processIsAlive(current.runtime_starter_pid)) return;
      store.db
        .prepare(`UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL,
          runtime_startup_token=NULL WHERE id=? AND state='running' AND runtime_starting=1`)
        .run(reviewId);
    }
    const token = randomUUID();
    const changed = store.db
      .prepare(`UPDATE reviews SET runtime_starting=1, runtime_starter_pid=?, runtime_startup_token=?
        WHERE id=? AND state='running' AND startup_reserved=0 AND runtime_starting=0`)
      .run(process.pid, token, reviewId);
    if (changed.changes === 1) startupToken = token;
  });
  if (!startupToken) return;

  let spawned = false;
  try {
    const task = store.getTask(review.task_id);
    if (!task) throw new Error("review Task is missing");
    const launch = buildPiLaunch("reviewer", review.path, {
      SWITCHYARD_HOME: paths.home,
      SWITCHYARD_TASK_ID: task.id,
      SWITCHYARD_REVIEW_ID: reviewId,
    });
    await hooks.beforeLaunch?.();
    assertReviewerStartupClaim(store, review, startupToken);
    await ensureWindow(review.tmux_window, launch.cwd, shellCommand(launch));
    spawned = true;
    if (!(await windowAlive(review.tmux_window)))
      throw new Error("Reviewer Pi exited during startup");
    await hooks.afterLaunch?.();
    store.transaction(() => {
      const current = store.getReview(reviewId);
      const currentTask = store.getTask(review.task_id);
      if (
        current?.state !== "running" ||
        current.startup_reserved ||
        currentTask?.state !== "reviewing" ||
        currentTask.candidate_sha !== review.candidate_sha ||
        current.runtime_starting !== 1 ||
        current.runtime_startup_token !== startupToken
      ) {
        throw new Error("Reviewer startup claim was lost");
      }
      const changed = store.db
        .prepare(`UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL,
          runtime_startup_token=NULL WHERE id=? AND state='running' AND runtime_starting=1
          AND runtime_startup_token=?`)
        .run(reviewId, startupToken);
      if (changed.changes !== 1) throw new Error("Reviewer startup claim was lost");
      store.event(task.id, "reviewer.started", { review_id: reviewId, window: review.tmux_window });
    });
  } catch (error) {
    clearReviewerStartupClaim(store, reviewId, startupToken);
    if (spawned) await killWindow(review.tmux_window);
    throw error;
  }
}

function assertReviewerStartupClaim(
  store: StateStore,
  review: NonNullable<ReturnType<StateStore["getReview"]>>,
  token: string,
): void {
  const current = store.getReview(review.id);
  const task = store.getTask(review.task_id);
  if (
    current?.state !== "running" ||
    current.startup_reserved ||
    task?.state !== "reviewing" ||
    task.candidate_sha !== review.candidate_sha ||
    current.runtime_starting !== 1 ||
    current.runtime_startup_token !== token
  ) {
    throw new Error("Reviewer startup claim was lost");
  }
}

function clearReviewerStartupClaim(
  store: StateStore,
  reviewId: string,
  token: string | null,
): void {
  if (!token) return;
  store.transaction(() => {
    store.db
      .prepare(`UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL,
        runtime_startup_token=NULL WHERE id=? AND runtime_starting=1 AND runtime_startup_token=?`)
      .run(reviewId, token);
  });
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function buildWorkerDispatchContext(
  store: StateStore,
  taskId: string,
  replacement: boolean,
): string {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (!task || !workspace) throw new Error("task context is incomplete");
  const latestReview = store.getLatestReview(taskId);
  const findings = latestReview ? store.listFindings(latestReview.id) : [];
  const taskResumed =
    replacement &&
    task.state === "running" &&
    store.listEvents(taskId).some((event) => event.type === "task.resumed");
  const sections = [
    replacement ? "Resume this durable SwitchYard Task." : "Start this SwitchYard Task.",
    `Task ID: ${task.id}`,
    `Kind: ${task.kind}`,
    `Instruction:\n${task.instruction}`,
    `Workspace: ${workspace.path}`,
    `Branch: ${workspace.branch}`,
    `Base SHA: ${task.base_sha ?? "(not recorded)"}`,
  ];
  if (task.summary) sections.push(`Previous completion summary:\n${task.summary}`);
  if (task.verification_summary) {
    sections.push(`Previous verification summary:\n${task.verification_summary}`);
  }
  if (findings.length > 0) {
    sections.push(
      `Outstanding review findings:\n${findings
        .map((finding, index) => `${index + 1}. ${finding.summary}: ${finding.required_change}`)
        .join("\n")}`,
    );
  }
  if (taskResumed) {
    sections.push(
      "Recovery: this Task has already been resumed after a prior wait or Decision. Do not repeat that completed request. Continue from the existing Workspace and follow the latest Worker guidance in this dispatch.",
    );
  }
  return sections.join("\n\n");
}
