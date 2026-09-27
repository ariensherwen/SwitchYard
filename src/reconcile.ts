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
import type { StateStore } from "./state.ts";
import { failTask } from "./tasks.ts";
import { windowAlive } from "./tmux.ts";

export async function reconcile(store: StateStore, paths: SwitchYardPaths): Promise<void> {
  for (const task of store.listTasks()) {
    const latestReview = store.getLatestReview(task.id);

    if (["completed", "failed", "cancelled"].includes(task.state)) {
      await quiesceTaskRuntimes(store, task.id);
      if (latestReview) await cleanupFinishedReviewRuntime(store, latestReview.id);
      continue;
    }

    const workspace = store.getWorkspace(task.id);
    if (!workspace || !existsSync(workspace.path)) {
      failTask(store, task.id, "task workspace is missing during recovery");
      await quiesceTaskRuntimes(store, task.id);
      continue;
    }

    if (latestReview && latestReview.state !== "running" && task.state !== "reviewing") {
      await cleanupFinishedReviewRuntime(store, latestReview.id);
    }

    if (task.state === "waiting" || task.state === "needs_decision") continue;

    if (task.state === "starting") {
      const worker = store.getLiveWorker(task.id);
      if (worker?.state === "starting") await resumeReservedWorker(store, paths, worker);
      else await startWorker(store, paths, task.id);
      continue;
    }

    if (task.state === "running") {
      const worker = store.getLiveWorker(task.id);
      if (worker?.state === "starting") {
        await resumeReservedWorker(store, paths, worker);
      } else if (!worker || !(await windowAlive(worker.tmux_window))) {
        await replaceWorker(store, paths, task.id);
      }
      continue;
    }

    if (task.state === "reviewing") {
      const latest = latestReview;
      if (latest?.state === "clean" && latest.candidate_sha === task.candidate_sha) {
        store.transaction(() => {
          const changed = store.db
            .prepare(
              "UPDATE tasks SET state='completed', updated_at=? WHERE id=? AND state='reviewing' AND candidate_sha=?",
            )
            .run(new Date().toISOString(), task.id, latest.candidate_sha);
          if (changed.changes === 1) {
            store.event(task.id, "task.completed", { recovered_review_id: latest.id });
          }
        });
        await quiesceTaskRuntimes(store, task.id);
        await cleanupFinishedReviewRuntime(store, latest.id);
      } else if (latest?.state !== "running") {
        const reviewId = await beginReview(store, paths, task.id);
        await startReviewer(store, paths, reviewId);
      } else if (!(await windowAlive(latest.tmux_window))) {
        const outcome = recordReviewRuntimeFailure(
          store,
          latest.id,
          "reviewer runtime missing during recovery",
        );
        if (outcome === "retry") await startReviewer(store, paths, latest.id);
      }
    }
  }
}
