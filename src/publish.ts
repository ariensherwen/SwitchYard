import { validateProjectCheckout } from "./projects.ts";
import type { StateStore } from "./state.ts";
import {
  choosePushRemote,
  pushCommit,
  resolveCommit,
  validateImplementCandidate,
} from "./worktree.ts";

export interface PublishTargetResult {
  remote: string;
  status: "pushed" | "failed";
  error?: string;
}

export async function publishCompletedTask(
  store: StateStore,
  taskId: string,
  branchName: string,
  requestedRemotes?: string[],
): Promise<{
  project: string;
  branch: string;
  candidate_sha: string;
  targets: PublishTargetResult[];
}> {
  const task = store.getTask(taskId);
  if (task?.state !== "completed" || task.kind !== "implement")
    throw new Error("only completed implementation Tasks can be published");
  if (!task.candidate_sha || !task.base_sha)
    throw new Error("completed Task has no captured candidate revision");
  if (task.review_policy === "loop") {
    const review = store.getLatestReview(task.id);
    if (review?.state !== "clean" || review.candidate_sha !== task.candidate_sha)
      throw new Error("the completed candidate has no matching clean Review");
  }
  if (!task.project_id) throw new Error("transient Tasks cannot be published");
  const project = store.getProject(task.project_id);
  if (!project) throw new Error("registered Project is missing");
  const root = await validateProjectCheckout(store, project);
  const workspace = store.getWorkspace(task.id);
  if (!workspace) throw new Error("Task Workspace record is missing");

  const candidate = await resolveCommit(root, task.candidate_sha);
  if (workspace.provisioned === 1) {
    const exactCandidate = await validateImplementCandidate(
      workspace.path,
      workspace.branch,
      task.base_sha,
    );
    if (exactCandidate !== candidate)
      throw new Error("Task Workspace no longer contains its exact completed candidate");
  } else {
    const branchHead = await resolveCommit(root, `refs/heads/${workspace.branch}`);
    if (branchHead !== candidate)
      throw new Error("Task branch no longer points at its exact completed candidate");
  }
  const remotes = requestedRemotes?.length
    ? [...new Set(requestedRemotes)]
    : [await choosePushRemote(root, workspace.branch)];
  const targets: PublishTargetResult[] = [];
  for (const remote of remotes) {
    try {
      await pushCommit(root, candidate, branchName, remote);
      const target = { remote, status: "pushed" as const };
      targets.push(target);
      store.transaction(() => {
        store.event(task.id, "task.published", {
          candidate_sha: candidate,
          remote,
          branch: branchName,
        });
      });
    } catch (error) {
      const target = {
        remote,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
      targets.push(target);
      store.transaction(() => {
        store.event(task.id, "task.publish_failed", {
          candidate_sha: candidate,
          remote,
          branch: branchName,
          error: target.error,
        });
      });
    }
  }
  return { project: project.name, branch: branchName, candidate_sha: candidate, targets };
}
