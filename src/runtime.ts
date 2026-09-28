import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SwitchYardPaths } from "./home.ts";
import { enqueueMessage, signalWake } from "./inbox.ts";
import { buildPiLaunch, shellCommand } from "./pi.ts";
import type { StateStore, WorkerRecord } from "./state.ts";
import { now } from "./state.ts";
import { casTransition, taskSourceRoot, terminateActiveReviews } from "./tasks.ts";
import { ensureWindow, killWindow, windowAlive } from "./tmux.ts";
import { changedPaths, diffText, removeWorktree } from "./worktree.ts";

export async function startWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<string> {
  const task = store.getTask(taskId);
  const workspace = store.getWorkspace(taskId);
  if (task?.state !== "starting" || !workspace || workspace.provisioned !== 1) {
    throw new Error("task is not ready to start a worker");
  }

  let worker = store.getLiveWorker(taskId);
  if (worker?.state === "active") {
    if (await windowAlive(worker.tmux_window)) {
      activateWorkerAndTask(store, taskId, worker.id);
      return worker.id;
    }
    retireWorker(store, taskId, worker.id, "startup runtime disappeared");
    worker = undefined;
  }
  if (!worker) worker = reserveWorker(store, taskId, false);

  try {
    await launchReservedWorker(store, paths, worker);
    activateWorkerAndTask(store, taskId, worker.id);
    return worker.id;
  } catch (error) {
    await killWindow(worker.tmux_window);
    retireWorker(store, taskId, worker.id, "worker launch failed");
    throw error;
  }
}

export interface WorkerReplacementHooks {
  afterTaskCheck?: () => void | Promise<void>;
  afterReservation?: () => void | Promise<void>;
}

export interface WorkerResumeHooks {
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
  if (task?.state !== "running" || !workspace) {
    throw new Error("task is not ready for a replacement Worker");
  }
  await hooks.afterTaskCheck?.();

  const live = store.getLiveWorker(taskId);
  if (live?.state === "starting") {
    try {
      await launchReservedWorker(store, paths, live);
      activateReservedWorker(store, taskId, live.id);
      return live.id;
    } catch (error) {
      await killWindow(live.tmux_window);
      retireWorker(store, taskId, live.id, "replacement launch failed");
      throw error;
    }
  }
  if (live?.state === "active") {
    if (await windowAlive(live.tmux_window)) return live.id;
    retireWorker(store, taskId, live.id, "worker runtime disappeared");
  }

  const worker = reserveWorker(store, taskId, true);
  try {
    await hooks.afterReservation?.();
    await launchReservedWorker(store, paths, worker);
    activateReservedWorker(store, taskId, worker.id);
    return worker.id;
  } catch (error) {
    await killWindow(worker.tmux_window);
    retireWorker(store, taskId, worker.id, "replacement launch failed");
    throw error;
  }
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
  ) {
    return;
  }
  if (!task || !["starting", "running"].includes(task.state)) {
    await cleanupFailedReservedWorker(
      store,
      reservedWorker?.id === worker.id ? reservedWorker : worker,
    );
    throw new Error(`cannot resume reserved Worker while task is ${task?.state ?? "missing"}`);
  }
  if (reservedWorker?.id !== worker.id || reservedWorker.state !== "starting") {
    await cleanupFailedReservedWorker(store, worker);
    throw new Error("reserved Worker identity is no longer starting");
  }

  try {
    await launchReservedWorker(store, paths, reservedWorker);
    await hooks.afterLaunch?.();
    const currentTask = store.getTask(worker.task_id);
    const currentWorker = store.getLiveWorker(worker.task_id);
    if (currentWorker?.id !== worker.id || currentWorker.state !== "starting") {
      throw new Error("reserved Worker identity is no longer starting");
    }
    if (currentTask?.state === "starting") activateWorkerAndTask(store, currentTask.id, worker.id);
    else if (currentTask?.state === "running")
      activateReservedWorker(store, currentTask.id, worker.id);
    else
      throw new Error(
        `cannot activate reserved Worker while task is ${currentTask?.state ?? "missing"}`,
      );
  } catch (error) {
    await cleanupFailedReservedWorker(store, reservedWorker);
    throw error;
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

function reserveWorker(store: StateStore, taskId: string, replacement: boolean): WorkerRecord {
  const workerId = randomUUID();
  const window = `task-${taskId}`;
  store.transaction(() => {
    const task = store.getTask(taskId);
    const expectedState = replacement ? "running" : "starting";
    if (task?.state !== expectedState) {
      throw new Error(`task ${taskId} is ${task?.state ?? "missing"}, expected ${expectedState}`);
    }
    if (store.getLiveWorker(taskId)) throw new Error("task already has a live Worker identity");
    store.db
      .prepare(
        `INSERT INTO workers(id, task_id, state, tmux_window, created_at)
         VALUES (?, ?, 'starting', ?, ?)`,
      )
      .run(workerId, taskId, window, now());
    store.event(taskId, "worker.reserved", { worker_id: workerId, window, replacement });
    enqueueMessage(store, taskId, "worker", buildWorkerDispatchContext(store, taskId, replacement));
  });
  const worker = store.getLiveWorker(taskId);
  if (!worker || worker.id !== workerId) throw new Error("failed to reserve Worker identity");
  return worker;
}

async function launchReservedWorker(
  store: StateStore,
  paths: SwitchYardPaths,
  worker: WorkerRecord,
): Promise<void> {
  const workspace = store.getWorkspace(worker.task_id);
  if (workspace?.provisioned !== 1) throw new Error("worker workspace is not ready");
  const prompt =
    `You are the SwitchYard Worker for task ${worker.task_id}. ` +
    "Work only in this task Workspace. The durable Task instruction/context arrives as Pi user input. " +
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

function activateWorkerAndTask(store: StateStore, taskId: string, workerId: string): void {
  store.transaction(() => {
    const worker = store.db
      .prepare(
        "UPDATE workers SET state='active' WHERE id=? AND task_id=? AND state IN ('starting','active')",
      )
      .run(workerId, taskId);
    if (worker.changes !== 1) throw new Error("reserved Worker identity is no longer live");
    casTransition(store, taskId, "starting", "running");
    store.event(taskId, "worker.started", { worker_id: workerId });
    store.event(taskId, "task.started", { worker_id: workerId });
    enqueueMessage(store, taskId, "supervisor", `Task ${taskId} started`);
  });
}

function activateReservedWorker(store: StateStore, taskId: string, workerId: string): void {
  store.transaction(() => {
    const task = store.getTask(taskId);
    if (task?.state !== "running") {
      throw new Error(
        `cannot activate replacement Worker while task is ${task?.state ?? "missing"}`,
      );
    }
    const changed = store.db
      .prepare("UPDATE workers SET state='active' WHERE id=? AND task_id=? AND state='starting'")
      .run(workerId, taskId);
    if (changed.changes !== 1) throw new Error("reserved Worker identity is no longer starting");
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
        "UPDATE workers SET state='stopped', ended_at=? WHERE id=? AND task_id=? AND state IN ('starting','active')",
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

export async function startReviewer(
  store: StateStore,
  paths: SwitchYardPaths,
  reviewId: string,
): Promise<void> {
  const review = store.getReview(reviewId);
  if (review?.state !== "running") throw new Error("review is not running");
  if (review.startup_reserved) throw new Error("Review worktree startup is not complete");

  if (await windowAlive(review.tmux_window)) {
    if (review.runtime_starting && !processIsAlive(review.runtime_starter_pid)) {
      clearReviewerStartupClaim(store, reviewId, review.runtime_starter_pid ?? undefined);
    }
    return;
  }

  const claimed = store.transaction(() => {
    const current = store.getReview(reviewId);
    if (current?.state !== "running" || current.startup_reserved) return false;
    if (current.runtime_starting) {
      if (processIsAlive(current.runtime_starter_pid)) return false;
      store.db
        .prepare(
          "UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL WHERE id=? AND state='running' AND runtime_starting=1",
        )
        .run(reviewId);
    }
    const changed = store.db
      .prepare(
        `UPDATE reviews SET runtime_starting=1, runtime_starter_pid=?
         WHERE id=? AND state='running' AND startup_reserved=0 AND runtime_starting=0`,
      )
      .run(process.pid, reviewId);
    return changed.changes === 1;
  });
  if (!claimed) return;

  try {
    const task = store.getTask(review.task_id);
    const workspace = store.getWorkspace(review.task_id);
    if (!task?.base_sha || !workspace) throw new Error("task/base/workspace not found");
    const pathsChanged = await changedPaths(workspace.path, task.base_sha, review.candidate_sha);
    const diff = await diffText(workspace.path, task.base_sha, review.candidate_sha);
    const prompt = [
      `You are an independent SwitchYard Reviewer for task ${task.id}.`,
      "Do not modify files. Review only the exact detached candidate revision in your current directory.",
      `Original instruction:\n${task.instruction}`,
      `Worker completion summary:\n${task.summary ?? "(none)"}`,
      `Worker verification summary:\n${task.verification_summary ?? "(none)"}`,
      `Candidate SHA: ${review.candidate_sha}`,
      `Changed paths:\n${pathsChanged.join("\n") || "(none)"}`,
      `Candidate diff:\n${diff || "(empty diff)"}`,
      "Submit exactly one structured result with switchyard_submit_review.",
    ].join("\n\n");
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
    if (!(await windowAlive(review.tmux_window)))
      throw new Error("Reviewer Pi exited during startup");
    store.transaction(() => {
      store.db
        .prepare(
          "UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL WHERE id=? AND runtime_starting=1 AND runtime_starter_pid=?",
        )
        .run(reviewId, process.pid);
      store.event(task.id, "reviewer.started", { review_id: reviewId, window: review.tmux_window });
    });
  } catch (error) {
    clearReviewerStartupClaim(store, reviewId);
    throw error;
  }
}

function clearReviewerStartupClaim(
  store: StateStore,
  reviewId: string,
  ownerPid = process.pid,
): void {
  store.transaction(() => {
    store.db
      .prepare(
        "UPDATE reviews SET runtime_starting=0, runtime_starter_pid=NULL WHERE id=? AND runtime_starting=1 AND runtime_starter_pid=?",
      )
      .run(reviewId, ownerPid);
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
