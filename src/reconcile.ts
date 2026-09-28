import { existsSync } from "node:fs";
import type { SwitchYardPaths } from "./home.ts";
import { beginReview, recordReviewRuntimeFailure } from "./review.ts";
import {
  cleanupFinishedReviewRuntime,
  quiesceTaskRuntimes,
  replaceWorker,
  resumeReservedWorker,
  startReviewer,
  startWorker,
} from "./runtime.ts";
import type { StateStore, TaskRecord, TaskState } from "./state.ts";
import { completeRecoveredReview, failTask, startTask, terminateActiveReviews } from "./tasks.ts";
import { windowAlive } from "./tmux.ts";

const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled"]);

export async function reconcile(store: StateStore, paths: SwitchYardPaths): Promise<void> {
  for (const task of store.listTasks()) {
    try {
      await reconcileTask(store, paths, task);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      store.transaction(() => {
        const current = store.getTask(task.id);
        if (current && !TERMINAL.has(current.state)) {
          failTask(store, task.id, `recovery failed: ${failure}`);
        }
        store.event(task.id, "task.recovery_failed", { failure });
      });
      try {
        await quiesceTaskRuntimes(store, task.id);
      } catch (cleanupError) {
        store.transaction(() => {
          store.event(task.id, "task.recovery_cleanup_failed", {
            failure: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
      }
    }
  }
}

async function reconcileTask(
  store: StateStore,
  paths: SwitchYardPaths,
  task: TaskRecord,
): Promise<void> {
  const reviews = store.listReviews(task.id);
  const latestReview = reviews[0];

  if (TERMINAL.has(task.state)) {
    store.transaction(() =>
      terminateActiveReviews(store, task.id, task.state as "completed" | "failed" | "cancelled"),
    );
    await quiesceTaskRuntimes(store, task.id);
    return;
  }

  if (task.state === "queued" || task.state === "starting") {
    await startTask(store, paths, task.id);
    const current = store.getTask(task.id);
    if (current?.state === "running") {
      await reconcileTask(store, paths, current);
    } else if (current?.state === "starting" && store.getWorkspace(task.id)?.provisioned === 1) {
      const worker = store.getLiveWorker(task.id);
      if (worker?.state === "starting") await resumeReservedWorker(store, paths, worker);
      else await startWorker(store, paths, task.id);
    }
    return;
  }

  const workspace = store.getWorkspace(task.id);
  if (workspace?.provisioned !== 1 || !existsSync(workspace.path)) {
    failTask(store, task.id, "task workspace is missing or not provisioned during recovery");
    await quiesceTaskRuntimes(store, task.id);
    return;
  }

  for (const review of reviews) {
    if (
      review.state !== "running" &&
      (task.state !== "reviewing" || review.id !== latestReview?.id)
    ) {
      await cleanupFinishedReviewRuntime(store, review.id);
    }
  }

  if (task.state === "waiting" || task.state === "needs_decision") return;

  if (task.state === "running") {
    const worker = store.getLiveWorker(task.id);
    if (worker?.state === "starting") {
      await resumeReservedWorker(store, paths, worker);
    } else if (!worker || !(await windowAlive(worker.tmux_window))) {
      await replaceWorker(store, paths, task.id);
    }
    return;
  }

  if (task.state !== "reviewing") return;

  const latest = latestReview;
  if (latest?.state === "clean" && latest.candidate_sha === task.candidate_sha) {
    const completed = completeRecoveredReview(store, task.id, latest.candidate_sha, latest.id);
    if (completed) {
      await quiesceTaskRuntimes(store, task.id);
      await cleanupFinishedReviewRuntime(store, latest.id);
    }
  } else if (latest?.state !== "running" || latest.startup_reserved) {
    await beginAndStartReview(store, paths, task.id);
  } else if (!(await windowAlive(latest.tmux_window))) {
    const outcome = recordReviewRuntimeFailure(
      store,
      latest.id,
      "reviewer runtime missing during recovery",
    );
    if (outcome === "retry") await startReviewerSafely(store, paths, latest.id);
  }
}

async function beginAndStartReview(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<void> {
  let reviewId: string;
  try {
    reviewId = await beginReview(store, paths, taskId);
  } catch (error) {
    const task = store.getTask(taskId);
    const review = task?.candidate_sha
      ? store.getRunningReviewForCandidate(taskId, task.candidate_sha)
      : undefined;
    if (!review) throw error;
    recordReviewRuntimeFailure(
      store,
      review.id,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  await startReviewerSafely(store, paths, reviewId);
}

async function startReviewerSafely(
  store: StateStore,
  paths: SwitchYardPaths,
  reviewId: string,
): Promise<void> {
  try {
    await startReviewer(store, paths, reviewId);
  } catch (error) {
    if (store.getReview(reviewId)?.state !== "running") return;
    recordReviewRuntimeFailure(
      store,
      reviewId,
      error instanceof Error ? error.message : String(error),
    );
  }
}
