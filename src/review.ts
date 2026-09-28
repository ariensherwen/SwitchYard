import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SwitchYardPaths } from "./home.ts";
import { enqueueMessage } from "./inbox.ts";
import type { StateStore } from "./state.ts";
import { now } from "./state.ts";
import { casTransition } from "./tasks.ts";
import { taskWindowName } from "./tmux.ts";
import {
  changedPaths,
  createReviewWorktree,
  validateImplementCandidate,
  validateReviewCheckout,
} from "./worktree.ts";

export interface ReviewFindingInput {
  summary: string;
  rationale: string;
  required_change: string;
  path?: string;
  line?: number;
}

export interface ReviewSubmission {
  verdict: "clean" | "changes_requested";
  summary: string;
  reviewed_paths: string[];
  findings: ReviewFindingInput[];
}

export async function beginReview(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<string> {
  const task = store.getTask(taskId);
  if (task?.state !== "reviewing" || !task.candidate_sha)
    throw new Error("task is not ready for review");
  const candidateSha = task.candidate_sha;
  const project = task.project_id ? store.getProject(task.project_id) : undefined;
  if (!project) throw new Error("review requires a registered Project");
  const id = randomUUID();
  const reviewPath = path.join(paths.reviews, taskId, id);
  const tmuxWindow = taskWindowName("review", project.name, task.title, id);
  const review = store.transaction(() => {
    const currentTask = store.getTask(taskId);
    if (currentTask?.state !== "reviewing" || currentTask.candidate_sha !== candidateSha)
      throw new Error("task is no longer ready for this review");
    const current = store.getRunningReviewForCandidate(taskId, candidateSha);
    if (current) return current;
    store.db
      .prepare(`INSERT INTO reviews(
        id, task_id, candidate_sha, state, attempts, tmux_window, path, created_at,
        startup_reserved, runtime_starting, runtime_starter_pid
      ) VALUES (?, ?, ?, 'running', 1, ?, ?, ?, 1, 0, NULL)`)
      .run(id, taskId, candidateSha, tmuxWindow, reviewPath, now());
    store.event(taskId, "review.reserved", { review_id: id, candidate_sha: candidateSha });
    const reserved = store.getReview(id);
    if (!reserved) throw new Error("failed to reserve Review identity");
    return reserved;
  });

  if (review.startup_reserved || !existsSync(review.path)) {
    await ensureReviewWorktree(project.root_path, review.path, review.candidate_sha);
    store.transaction(() => {
      const changed = store.db
        .prepare(
          "UPDATE reviews SET startup_reserved=0 WHERE id=? AND state='running' AND startup_reserved=1",
        )
        .run(review.id);
      if (changed.changes === 1) {
        store.event(taskId, "review.started", {
          review_id: review.id,
          candidate_sha: review.candidate_sha,
        });
      }
    });
  }
  return review.id;
}

export async function submitReview(
  store: StateStore,
  reviewId: string,
  submission: ReviewSubmission,
): Promise<void> {
  const review = store.getReview(reviewId);
  if (review?.state !== "running") throw new Error("running review not found");
  const task = store.getTask(review.task_id);
  if (task?.state !== "reviewing") throw new Error("task is not currently reviewing");
  if (task.candidate_sha !== review.candidate_sha)
    throw new Error("stale review certification: task candidate changed");
  if (submission.verdict === "clean" && submission.findings.length !== 0)
    throw new Error("clean review must have zero findings");
  if (submission.verdict === "changes_requested" && submission.findings.length === 0)
    throw new Error("changes_requested review must include findings");

  await validateReviewCheckout(review.path, review.candidate_sha);
  if (!task.base_sha) throw new Error("task base revision is missing");
  const workspace = store.getWorkspace(task.id);
  if (!workspace) throw new Error("task workspace is missing");
  const currentWorkerHead = await validateImplementCandidate(
    workspace.path,
    workspace.branch,
    task.base_sha,
  );
  if (currentWorkerHead !== review.candidate_sha)
    throw new Error(
      "stale review certification: Worker workspace changed after candidate submission",
    );
  const expectedPaths = await changedPaths(workspace.path, task.base_sha, review.candidate_sha);
  const reviewedPaths = [...new Set(submission.reviewed_paths)].sort();
  if (JSON.stringify(reviewedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("reviewed_paths must exactly cover the candidate changed-path set");
  }

  store.transaction(() => {
    const state = submission.verdict === "clean" ? "clean" : "changes_requested";
    const updated = store.db
      .prepare(
        `UPDATE reviews SET state=?, summary=?, completed_at=?, startup_reserved=0,
          runtime_starting=0, runtime_starter_pid=NULL, runtime_startup_token=NULL
          WHERE id=? AND state='running'`,
      )
      .run(state, submission.summary, now(), reviewId);
    if (updated.changes !== 1) throw new Error("review changed concurrently");
    for (const finding of submission.findings) {
      store.db
        .prepare(`INSERT INTO findings(id, review_id, summary, rationale, required_change, path, line)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          randomUUID(),
          reviewId,
          finding.summary,
          finding.rationale,
          finding.required_change,
          finding.path ?? null,
          finding.line ?? null,
        );
    }
    if (state === "clean") {
      const current = store.getTask(task.id);
      if (!current || current.candidate_sha !== review.candidate_sha)
        throw new Error("candidate changed during review completion");
      store.event(task.id, "review.clean", {
        review_id: reviewId,
        candidate_sha: review.candidate_sha,
      });
      if (store.listPendingMessages(task.id, "worker").length > 0) {
        casTransition(store, task.id, "reviewing", "running");
        store.event(task.id, "task.resumed", { reason: "steering received during review" });
        enqueueMessage(
          store,
          task.id,
          "supervisor",
          "The review passed, and additional guidance is queued. Implementation is resuming.",
        );
      } else {
        casTransition(store, task.id, "reviewing", "completed");
        store.event(task.id, "task.completed", { candidate_sha: review.candidate_sha });
        enqueueMessage(
          store,
          task.id,
          "supervisor",
          "Implementation completed after a clean review.",
        );
      }
    } else {
      casTransition(store, task.id, "reviewing", "running");
      store.event(task.id, "review.changes_requested", {
        review_id: reviewId,
        findings: submission.findings.length,
      });
      const details = submission.findings
        .map((f, i) => `${i + 1}. ${f.summary}: ${f.required_change}`)
        .join("\n");
      enqueueMessage(store, task.id, "worker", `Review ${reviewId} requested changes:\n${details}`);
      enqueueMessage(
        store,
        task.id,
        "supervisor",
        `The implementation review requested ${submission.findings.length} change(s).`,
      );
    }
  });
}

export function recordReviewRuntimeFailure(
  store: StateStore,
  reviewId: string,
  failure: string,
): "retry" | "decision" {
  const review = store.getReview(reviewId);
  if (review?.state !== "running") throw new Error("running review not found");
  if (review.runtime_starting && processIsAlive(review.runtime_starter_pid)) return "retry";
  if (review.attempts < 3) {
    store.transaction(() => {
      const changed = store.db
        .prepare(
          `UPDATE reviews SET attempts=attempts+1, runtime_starting=0,
            runtime_starter_pid=NULL, runtime_startup_token=NULL WHERE id=? AND state='running'`,
        )
        .run(reviewId);
      if (changed.changes !== 1) throw new Error("running review changed concurrently");
      store.event(review.task_id, "review.retry", {
        review_id: reviewId,
        failure,
        attempt: review.attempts + 1,
      });
    });
    return "retry";
  }
  const decisionId = randomUUID();
  store.transaction(() => {
    const changed = store.db
      .prepare(
        `UPDATE reviews SET state='failed', summary=?, completed_at=?, runtime_starting=0,
          runtime_starter_pid=NULL, runtime_startup_token=NULL WHERE id=? AND state='running'`,
      )
      .run(failure, now(), reviewId);
    if (changed.changes !== 1) throw new Error("running review changed concurrently");
    casTransition(store, review.task_id, "reviewing", "needs_decision");
    store.db
      .prepare(`INSERT INTO decisions(id, task_id, question, context, state, created_at)
      VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(
        decisionId,
        review.task_id,
        "Review infrastructure failed three times. How should SwitchYard proceed?",
        failure,
        now(),
      );
    store.event(review.task_id, "review.failed", { review_id: reviewId, failure });
    store.event(review.task_id, "decision.requested", { id: decisionId, source: "review_failure" });
    enqueueMessage(
      store,
      review.task_id,
      "supervisor",
      "Review setup failed three times and needs a decision.",
    );
  });
  return "decision";
}

async function ensureReviewWorktree(
  projectRoot: string,
  reviewPath: string,
  candidateSha: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if (existsSync(reviewPath)) {
        await validateReviewCheckout(reviewPath, candidateSha);
      } else {
        await createReviewWorktree(projectRoot, reviewPath, candidateSha);
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
