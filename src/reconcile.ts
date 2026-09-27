import { existsSync } from "node:fs";
import type { SwitchYardPaths } from "./home.ts";
import { beginReview, recordReviewRuntimeFailure } from "./review.ts";
import { replaceWorker, startReviewer, startWorker } from "./runtime.ts";
import type { StateStore } from "./state.ts";
import { failTask } from "./tasks.ts";
import { windowAlive } from "./tmux.ts";

export async function reconcile(store: StateStore, paths: SwitchYardPaths): Promise<void> {
  for (const task of store.listTasks()) {
    if (["completed", "failed", "cancelled"].includes(task.state)) continue;
    const workspace = store.getWorkspace(task.id);
    if (!workspace || !existsSync(workspace.path)) {
      failTask(store, task.id, "task workspace is missing during recovery");
      continue;
    }
    if (task.state === "waiting" || task.state === "needs_decision") continue;
    if (task.state === "starting") {
      const worker = store.getActiveWorker(task.id);
      if (!worker || !(await windowAlive(worker.tmux_window))) {
        await startWorker(store, paths, task.id);
      } else {
        const { markRunning } = await import("./tasks.ts");
        markRunning(store, task.id);
      }
      continue;
    }
    if (task.state === "running") {
      const worker = store.getActiveWorker(task.id);
      if (!worker || !(await windowAlive(worker.tmux_window))) {
        await replaceWorker(store, paths, task.id);
      }
      continue;
    }
    if (task.state === "reviewing") {
      const latest = store.getLatestReview(task.id);
      if (latest?.state === "clean" && latest.candidate_sha === task.candidate_sha) {
        // submitReview normally completes atomically; a clean persisted row here is treated as recoverable evidence.
        store.transaction(() => {
          store.db
            .prepare(
              "UPDATE tasks SET state='completed' WHERE id=? AND state='reviewing' AND candidate_sha=?",
            )
            .run(task.id, latest.candidate_sha);
          store.event(task.id, "task.completed", { recovered_review_id: latest.id });
        });
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
