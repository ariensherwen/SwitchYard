import { validateProjectCheckout } from "./projects.ts";
import type { StateStore, TaskRecord } from "./state.ts";
import { markWorkspaceCleaned } from "./tasks.ts";
import {
  canSafelyClean,
  fastForwardOnly,
  projectIsSafeLandingTarget,
  removeWorktree,
  validateImplementCandidate,
} from "./worktree.ts";

export type LandingResult =
  | {
      status: "landed";
      project: string;
      branch: string;
      candidate_sha: string;
      workspace: "cleaned" | "preserved" | "cleanup_failed";
    }
  | {
      status: "diverged";
      project: string;
      branch: string;
      target_sha: string;
      base_sha: string;
      candidate_sha: string;
    };

export async function landCompletedTask(store: StateStore, taskId: string): Promise<LandingResult> {
  const task = requiredTask(store, taskId);
  if (task.state !== "completed" || task.kind !== "implement")
    throw new Error("only completed implementation Tasks can be landed");
  if (!task.base_sha || !task.candidate_sha)
    throw new Error("completed Task has no captured base or candidate revision");
  if (task.review_policy === "loop") {
    const review = store.getLatestReview(task.id);
    if (review?.state !== "clean" || review.candidate_sha !== task.candidate_sha)
      throw new Error("the current candidate has no matching clean Review");
  }
  if (!task.project_id) throw new Error("transient Tasks cannot be landed");
  const project = store.getProject(task.project_id);
  if (!project) throw new Error("registered Project is missing");
  const projectRoot = await validateProjectCheckout(store, project);
  const workspace = store.getWorkspace(task.id);
  if (workspace?.provisioned !== 1)
    throw new Error("Task Workspace is missing; refusing to land an unverified candidate");
  const candidate = await validateImplementCandidate(
    workspace.path,
    workspace.branch,
    task.base_sha,
  );
  if (candidate !== task.candidate_sha)
    throw new Error("Task Workspace no longer points at its completed candidate");
  if (!(await projectIsSafeLandingTarget(projectRoot)))
    throw new Error(`${project.name} has local changes; landing requires a clean Project checkout`);

  const outcome = await fastForwardOnly(projectRoot, task.base_sha, candidate);
  if (outcome.status === "diverged") {
    store.transaction(() => {
      store.event(task.id, "task.landing_refused", {
        target_sha: outcome.head,
        base_sha: task.base_sha,
        candidate_sha: candidate,
      });
    });
    return {
      status: "diverged",
      project: project.name,
      branch: outcome.branch,
      target_sha: outcome.head,
      base_sha: task.base_sha,
      candidate_sha: candidate,
    };
  }

  store.transaction(() => {
    store.event(task.id, "task.landed", {
      project_id: project.id,
      branch: outcome.branch,
      candidate_sha: candidate,
    });
  });
  const workspaceStatus = await cleanupLandedWorkspace(store, task, projectRoot, workspace.path);
  return {
    status: "landed",
    project: project.name,
    branch: outcome.branch,
    candidate_sha: candidate,
    workspace: workspaceStatus,
  };
}

async function cleanupLandedWorkspace(
  store: StateStore,
  task: TaskRecord,
  projectRoot: string,
  workspacePath: string,
): Promise<"cleaned" | "preserved" | "cleanup_failed"> {
  if (store.getLiveWorker(task.id)) return "preserved";
  if (store.getLatestReview(task.id)?.state === "running") return "preserved";
  try {
    if (!task.base_sha || !(await canSafelyClean(projectRoot, workspacePath, task.base_sha)))
      return "preserved";
    await removeWorktree(projectRoot, workspacePath);
    markWorkspaceCleaned(store, task.id);
    return "cleaned";
  } catch (error) {
    store.transaction(() => {
      store.event(task.id, "workspace.cleanup_failed", {
        reason: error instanceof Error ? error.message : String(error),
        after_landing: true,
      });
    });
    return "cleanup_failed";
  }
}

function requiredTask(store: StateStore, taskId: string): TaskRecord {
  const task = store.getTask(taskId);
  if (!task) throw new Error("Task not found");
  return task;
}
