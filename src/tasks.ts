import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SwitchYardPaths } from "./home.ts";
import { enqueueMessage } from "./inbox.ts";
import type { ReviewPolicy, StateStore, TaskKind, TaskRecord, TaskState } from "./state.ts";
import { now } from "./state.ts";
import {
  createWorkspace,
  validateImplementCandidate,
  validateInvestigateCompletion,
} from "./worktree.ts";

const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled"]);
const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  queued: ["starting", "failed", "cancelled"],
  starting: ["running", "failed", "cancelled"],
  running: ["waiting", "needs_decision", "reviewing", "completed", "failed", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  needs_decision: ["running", "failed", "cancelled"],
  reviewing: ["running", "needs_decision", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createTask(
  store: StateStore,
  projectId: string,
  kind: TaskKind,
  instruction: string,
  reviewPolicy: ReviewPolicy,
): TaskRecord {
  if (reviewPolicy === "loop" && kind !== "implement")
    throw new Error("review loop is supported only for implement tasks");
  const id = randomUUID();
  const timestamp = now();
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO tasks(id, project_id, kind, instruction, review_policy, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(id, projectId, kind, instruction, reviewPolicy, timestamp, timestamp);
    store.event(id, "task.created", { kind, review: reviewPolicy });
  });
  return requiredTask(store, id);
}

export async function startTask(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
): Promise<TaskRecord> {
  const task = requiredTask(store, taskId);
  const project = store.getProject(task.project_id);
  if (!project) throw new Error(`project not found: ${task.project_id}`);
  transition(store, taskId, "queued", "starting", "task.starting");
  const workspacePath = path.join(paths.worktrees, project.id, taskId);
  const branch = `switchyard/task-${taskId}`;
  try {
    const workspace = await createWorkspace(project.root_path, workspacePath, branch);
    store.transaction(() => {
      store.db
        .prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
        .run(taskId, workspace.path, workspace.branch, now());
      store.db
        .prepare("UPDATE tasks SET base_sha=?, updated_at=? WHERE id=? AND state='starting'")
        .run(workspace.baseSha, now(), taskId);
    });
    return requiredTask(store, taskId);
  } catch (error) {
    failTask(store, taskId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function markRunning(store: StateStore, taskId: string): TaskRecord {
  return transition(store, taskId, "starting", "running", "task.started");
}

export function markWaiting(store: StateStore, taskId: string, reason: string): TaskRecord {
  const result = transition(store, taskId, "running", "waiting", "task.waiting", { reason });
  enqueueMessage(store, taskId, "supervisor", `Task ${taskId} is waiting: ${reason}`);
  return result;
}

export function resumeWaiting(store: StateStore, taskId: string, message?: string): TaskRecord {
  const result = transition(store, taskId, "waiting", "running", "task.resumed");
  if (message) enqueueMessage(store, taskId, "worker", message);
  return result;
}

export function steerTask(store: StateStore, taskId: string, message: string): TaskRecord {
  const task = requiredTask(store, taskId);
  if (TERMINAL.has(task.state)) throw new Error("cannot steer a terminal task");
  if (task.state === "waiting") return resumeWaiting(store, taskId, message);
  enqueueMessage(store, taskId, "worker", message);
  return requiredTask(store, taskId);
}

export function requestDecision(
  store: StateStore,
  taskId: string,
  question: string,
  context?: string,
  options?: string[],
): string {
  const id = randomUUID();
  store.transaction(() => {
    casTransition(store, taskId, "running", "needs_decision");
    store.db
      .prepare(`INSERT INTO decisions(id, task_id, question, context, options_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)`)
      .run(id, taskId, question, context ?? null, options ? JSON.stringify(options) : null, now());
    store.event(taskId, "decision.requested", { id, question });
    enqueueMessage(store, taskId, "supervisor", `Decision requested: ${question}`);
  });
  return id;
}

export function resolveDecision(
  store: StateStore,
  taskId: string,
  decisionId: string,
  answer: string,
): TaskRecord {
  store.transaction(() => {
    const decision = store.getDecision(decisionId);
    if (!decision || decision.task_id !== taskId || decision.state !== "open")
      throw new Error("open decision not found for task");
    const changed = store.db
      .prepare(
        "UPDATE decisions SET state='resolved', answer=?, resolved_at=? WHERE id=? AND state='open'",
      )
      .run(answer, now(), decisionId);
    if (changed.changes !== 1) throw new Error("decision was already resolved");
    casTransition(store, taskId, "needs_decision", "running");
    enqueueMessage(store, taskId, "worker", `Decision ${decisionId} answered: ${answer}`);
    store.event(taskId, "decision.resolved", { id: decisionId, answer });
    store.event(taskId, "task.resumed", { decision_id: decisionId });
  });
  return requiredTask(store, taskId);
}

export async function submitCandidate(
  store: StateStore,
  taskId: string,
  summary: string,
  verificationSummary: string,
): Promise<{ task: TaskRecord; candidateSha: string | null }> {
  const task = requiredTask(store, taskId);
  if (task.state !== "running")
    throw new Error(`task ${taskId} is ${task.state}, expected running`);
  const workspace = store.getWorkspace(taskId);
  if (!workspace || !task.base_sha) throw new Error("task workspace/base revision is missing");

  if (task.kind === "investigate") {
    await validateInvestigateCompletion(workspace.path, task.base_sha);
    store.transaction(() => {
      casTransition(store, taskId, "running", "completed");
      store.db
        .prepare("UPDATE tasks SET summary=?, verification_summary=?, updated_at=? WHERE id=?")
        .run(summary, verificationSummary, now(), taskId);
      store.event(taskId, "task.completed", { summary });
      enqueueMessage(store, taskId, "supervisor", `Task ${taskId} completed: ${summary}`);
    });
    return { task: requiredTask(store, taskId), candidateSha: null };
  }

  const candidateSha = await validateImplementCandidate(
    workspace.path,
    workspace.branch,
    task.base_sha,
  );
  const previousReview = store.getLatestReview(taskId);
  if (
    previousReview?.state === "changes_requested" &&
    previousReview.candidate_sha === candidateSha
  ) {
    throw new Error("candidate SHA is unchanged after changes were requested");
  }
  store.transaction(() => {
    store.db
      .prepare(
        "UPDATE tasks SET candidate_sha=?, summary=?, verification_summary=?, updated_at=? WHERE id=? AND state='running'",
      )
      .run(candidateSha, summary, verificationSummary, now(), taskId);
    if (task.review_policy === "loop") {
      casTransition(store, taskId, "running", "reviewing");
      store.event(taskId, "task.reviewing", { candidate_sha: candidateSha });
      enqueueMessage(
        store,
        taskId,
        "supervisor",
        `Task ${taskId} entered review for ${candidateSha}`,
      );
    } else {
      casTransition(store, taskId, "running", "completed");
      store.event(taskId, "task.completed", { candidate_sha: candidateSha, summary });
      enqueueMessage(store, taskId, "supervisor", `Task ${taskId} completed: ${summary}`);
    }
  });
  return { task: requiredTask(store, taskId), candidateSha };
}

export function cancelTask(store: StateStore, taskId: string): TaskRecord {
  const task = requiredTask(store, taskId);
  if (TERMINAL.has(task.state))
    throw new Error(`task ${taskId} is already terminal: ${task.state}`);
  store.transaction(() => {
    casTransition(store, taskId, task.state, "cancelled");
    store.event(taskId, "task.cancelled");
    enqueueMessage(store, taskId, "supervisor", `Task ${taskId} cancelled`);
  });
  return requiredTask(store, taskId);
}

export function failTask(store: StateStore, taskId: string, failure: string): TaskRecord {
  const task = requiredTask(store, taskId);
  if (TERMINAL.has(task.state)) return task;
  store.transaction(() => {
    casTransition(store, taskId, task.state, "failed");
    store.db
      .prepare("UPDATE tasks SET failure=?, updated_at=? WHERE id=?")
      .run(failure, now(), taskId);
    store.event(taskId, "task.failed", { failure });
    enqueueMessage(store, taskId, "supervisor", `Task ${taskId} failed: ${failure}`);
  });
  return requiredTask(store, taskId);
}

export function transition(
  store: StateStore,
  taskId: string,
  from: TaskState,
  to: TaskState,
  eventType: string,
  payload: unknown = {},
): TaskRecord {
  if (!ALLOWED[from].includes(to)) throw new Error(`illegal task transition ${from} -> ${to}`);
  store.transaction(() => {
    casTransition(store, taskId, from, to);
    store.event(taskId, eventType, payload);
  });
  return requiredTask(store, taskId);
}

export function casTransition(
  store: StateStore,
  taskId: string,
  from: TaskState,
  to: TaskState,
): void {
  if (!ALLOWED[from].includes(to)) throw new Error(`illegal task transition ${from} -> ${to}`);
  const result = store.db
    .prepare("UPDATE tasks SET state=?, updated_at=? WHERE id=? AND state=?")
    .run(to, now(), taskId, from);
  if (result.changes !== 1) {
    const current = store.getTask(taskId)?.state ?? "missing";
    throw new Error(`stale task transition ${from} -> ${to}; current state is ${current}`);
  }
}

function requiredTask(store: StateStore, taskId: string): TaskRecord {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return task;
}
