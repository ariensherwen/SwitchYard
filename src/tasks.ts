import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SwitchYardPaths } from "./home.ts";
import { enqueueMessage } from "./inbox.ts";
import type { ReviewPolicy, StateStore, TaskKind, TaskRecord, TaskState } from "./state.ts";
import { now } from "./state.ts";
import {
  ensureTaskWorkspace,
  ensureTransientRepository,
  taskWorkspaceBase,
  validateImplementCandidate,
  validateInvestigateCompletion,
} from "./worktree.ts";

const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled"]);

export function reviewPolicyForTask(kind: TaskKind, requested?: boolean): ReviewPolicy {
  const enabled = requested ?? kind === "implement";
  if (enabled && kind !== "implement")
    throw new Error("review loop is supported only for implement tasks");
  return enabled ? "loop" : "off";
}
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
  title = instruction,
): TaskRecord {
  if (reviewPolicy === "loop" && kind !== "implement")
    throw new Error("review loop is supported only for implement tasks");
  if (!title.trim()) throw new Error("task title is required");
  const id = randomUUID();
  const timestamp = now();
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO tasks(
        id, project_id, title, kind, instruction, review_policy, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(id, projectId, title, kind, instruction, reviewPolicy, timestamp, timestamp);
    store.event(id, "task.created", { kind, review: reviewPolicy });
  });
  return requiredTask(store, id);
}

export function createTransientInvestigation(
  store: StateStore,
  paths: SwitchYardPaths,
  sourceUrl: string,
  instruction: string,
  title = instruction,
): TaskRecord {
  if (!sourceUrl.trim()) throw new Error("transient source URL is required");
  if (!title.trim()) throw new Error("task title is required");
  const id = randomUUID();
  const timestamp = now();
  const sourcePath = path.join(paths.sources, id);
  store.transaction(() => {
    store.db
      .prepare(`INSERT INTO tasks(
        id, project_id, source_path, source_url, title, kind, instruction, review_policy, state,
        created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, 'investigate', ?, 'off', 'queued', ?, ?)`)
      .run(id, sourcePath, sourceUrl, title, instruction, timestamp, timestamp);
    store.event(id, "task.created", { kind: "investigate", review: "off", transient_source: true });
  });
  return requiredTask(store, id);
}

export function updateTaskTitle(store: StateStore, taskId: string, title: string): TaskRecord {
  const normalized = title.trim();
  if (!normalized) throw new Error("task title is required");
  store.transaction(() => {
    const changed = store.db
      .prepare("UPDATE tasks SET title=?, updated_at=? WHERE id=?")
      .run(normalized, now(), taskId);
    if (changed.changes !== 1) throw new Error(`task not found: ${taskId}`);
    store.event(taskId, "task.title_updated", { title: normalized });
  });
  return requiredTask(store, taskId);
}

export function taskSourceRoot(store: StateStore, task: TaskRecord): string {
  if (task.project_id) {
    const project = store.getProject(task.project_id);
    if (!project) throw new Error(`project not found: ${task.project_id}`);
    return project.root_path;
  }
  if (task.source_path) return task.source_path;
  throw new Error(`task ${task.id} has no source checkout`);
}

export function markWorkspaceCleaned(store: StateStore, taskId: string): void {
  store.transaction(() => {
    const task = requiredTask(store, taskId);
    if (!TERMINAL.has(task.state)) throw new Error("cannot clean a nonterminal Task Workspace");
    if (!store.getWorkspace(taskId)) throw new Error("task workspace is missing");
    const changed = store.db
      .prepare("UPDATE workspaces SET provisioned=0 WHERE task_id=? AND provisioned=1")
      .run(taskId);
    if (changed.changes === 1) store.event(taskId, "workspace.cleaned");
  });
}

export interface TaskStartupHooks {
  afterReservation?: () => void | Promise<void>;
  afterWorktreeProvisioned?: () => void | Promise<void>;
}

export async function startTask(
  store: StateStore,
  paths: SwitchYardPaths,
  taskId: string,
  hooks: TaskStartupHooks = {},
): Promise<TaskRecord> {
  const task = requiredTask(store, taskId);
  if (task.state !== "queued" && task.state !== "starting")
    throw new Error(`task ${taskId} is ${task.state}, expected queued or starting`);
  const project = task.project_id ? store.getProject(task.project_id) : undefined;
  if (task.project_id && !project) throw new Error(`project not found: ${task.project_id}`);
  let sourceRoot: string;
  if (project) {
    sourceRoot = project.root_path;
  } else if (
    task.kind === "investigate" &&
    task.review_policy === "off" &&
    task.source_path &&
    task.source_url
  ) {
    const expectedSourcePath = path.resolve(paths.sources, task.id);
    if (path.resolve(task.source_path) !== expectedSourcePath)
      throw new Error("transient source path is outside the SwitchYard home");
    sourceRoot = await ensureTransientRepository(task.source_url, task.source_path);
  } else {
    throw new Error("task requires a registered Project or a transient investigation source");
  }
  const workspacePath = path.join(paths.worktrees, project?.id ?? "transient", taskId);
  const branch = `switchyard/task-${taskId}`;
  let workspace = store.getWorkspace(taskId);
  let reserved = false;

  if (task.state === "queued") {
    const baseSha = await taskWorkspaceBase(sourceRoot, workspacePath, branch);
    store.transaction(() => {
      casTransition(store, taskId, "queued", "starting");
      if (!workspace) {
        store.db
          .prepare(`INSERT INTO workspaces(task_id, path, branch, provisioned, created_at)
            VALUES (?, ?, ?, 0, ?)`)
          .run(taskId, workspacePath, branch, now());
        store.event(taskId, "workspace.reserved", {
          path: workspacePath,
          branch,
          base_sha: baseSha,
        });
      }
      store.db
        .prepare("UPDATE tasks SET base_sha=?, updated_at=? WHERE id=? AND state='starting'")
        .run(baseSha, now(), taskId);
      store.event(taskId, "task.starting");
    });
    workspace = store.getWorkspace(taskId);
    reserved = true;
  } else if (task.state === "starting" && !workspace) {
    const baseSha = task.base_sha ?? (await taskWorkspaceBase(sourceRoot, workspacePath, branch));
    store.transaction(() => {
      const current = requiredTask(store, taskId);
      if (current.state !== "starting")
        throw new Error(`task is ${current.state}, expected starting`);
      store.db
        .prepare(`INSERT INTO workspaces(task_id, path, branch, provisioned, created_at)
          VALUES (?, ?, ?, 0, ?)`)
        .run(taskId, workspacePath, branch, now());
      store.db
        .prepare("UPDATE tasks SET base_sha=?, updated_at=? WHERE id=? AND state='starting'")
        .run(baseSha, now(), taskId);
      store.event(taskId, "workspace.reserved", {
        path: workspacePath,
        branch,
        base_sha: baseSha,
        recovered: true,
      });
    });
    workspace = store.getWorkspace(taskId);
    reserved = true;
  } else if (task.state !== "starting") {
    throw new Error(`task ${taskId} is ${task.state}, expected queued or starting`);
  }

  if (!workspace) throw new Error("task workspace reservation is missing");
  if (reserved) await hooks.afterReservation?.();
  if (workspace.provisioned === 0) {
    const baseSha = store.getTask(taskId)?.base_sha;
    if (!baseSha) throw new Error("task workspace base revision is missing");
    await ensureTaskWorkspace(sourceRoot, workspace.path, workspace.branch, baseSha);
    await hooks.afterWorktreeProvisioned?.();
    store.transaction(() => {
      const changed = store.db
        .prepare("UPDATE workspaces SET provisioned=1 WHERE task_id=? AND provisioned=0")
        .run(taskId);
      if (changed.changes === 1) store.event(taskId, "workspace.provisioned", { branch });
    });
  }
  return requiredTask(store, taskId);
}

export function markRunning(store: StateStore, taskId: string): TaskRecord {
  return transition(store, taskId, "starting", "running", "task.started");
}

export function markWaiting(store: StateStore, taskId: string, reason: string): TaskRecord {
  store.transaction(() => {
    casTransition(store, taskId, "running", "waiting");
    store.event(taskId, "task.waiting", { reason });
    enqueueMessage(store, taskId, "supervisor", `Task ${taskId} is waiting: ${reason}`);
  });
  return requiredTask(store, taskId);
}

export function resumeWaiting(store: StateStore, taskId: string, message: string): TaskRecord {
  if (!message.trim()) throw new Error("steering message is required");
  store.transaction(() => {
    casTransition(store, taskId, "waiting", "running");
    store.event(taskId, "task.resumed");
    enqueueMessage(store, taskId, "worker", message);
  });
  return requiredTask(store, taskId);
}

export function steerTask(store: StateStore, taskId: string, message: string): TaskRecord {
  const task = requiredTask(store, taskId);
  if (TERMINAL.has(task.state)) throw new Error("cannot steer a terminal task");
  if (task.state === "reviewing") throw new Error("cannot steer a task while it is under review");
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
  if (from === "reviewing" && to === "completed") {
    const task = store.getTask(taskId);
    const review = store.getLatestReview(taskId);
    if (
      task?.review_policy !== "loop" ||
      !task.candidate_sha ||
      review?.state !== "clean" ||
      review.candidate_sha !== task.candidate_sha
    ) {
      throw new Error("a review-enabled Task requires a clean Review of its current candidate");
    }
  }
  const result = store.db
    .prepare("UPDATE tasks SET state=?, updated_at=? WHERE id=? AND state=?")
    .run(to, now(), taskId, from);
  if (result.changes !== 1) {
    const current = store.getTask(taskId)?.state ?? "missing";
    throw new Error(`stale task transition ${from} -> ${to}; current state is ${current}`);
  }
  if (to === "completed" || to === "failed" || to === "cancelled") {
    cancelOpenDecision(store, taskId, to);
    terminateActiveReviews(store, taskId, to);
  }
}

function cancelOpenDecision(
  store: StateStore,
  taskId: string,
  terminalState: Extract<TaskState, "completed" | "failed" | "cancelled">,
): void {
  const changed = store.db
    .prepare(
      "UPDATE decisions SET state='cancelled', resolved_at=? WHERE task_id=? AND state='open'",
    )
    .run(now(), taskId);
  if (changed.changes > 0) {
    store.event(taskId, "decision.cancelled", { task_state: terminalState });
  }
}

export function completeRecoveredReview(
  store: StateStore,
  taskId: string,
  candidateSha: string,
  reviewId: string,
): boolean {
  return store.transaction(() => {
    const task = store.getTask(taskId);
    if (task?.state !== "reviewing" || task.candidate_sha !== candidateSha) return false;
    const review = store.getReview(reviewId);
    const latestReview = store.getLatestReview(taskId);
    if (
      task.review_policy !== "loop" ||
      review?.task_id !== taskId ||
      review.state !== "clean" ||
      review.candidate_sha !== candidateSha ||
      latestReview?.id !== reviewId
    ) {
      throw new Error("recovered completion requires a clean Review of the current candidate");
    }
    casTransition(store, taskId, "reviewing", "completed");
    store.event(taskId, "task.completed", { recovered_review_id: reviewId });
    return true;
  });
}

export function terminateActiveReviews(
  store: StateStore,
  taskId: string,
  terminalState: Extract<TaskState, "completed" | "failed" | "cancelled">,
): void {
  const reviews = store.db
    .prepare("SELECT id FROM reviews WHERE task_id=? AND state='running'")
    .all(taskId) as Array<{ id: string }>;
  const update = store.db.prepare(`UPDATE reviews SET state='failed', summary=?, completed_at=?,
    startup_reserved=0, runtime_starting=0, runtime_starter_pid=NULL WHERE id=? AND state='running'`);
  for (const review of reviews) {
    const reason = `Review aborted because Task became ${terminalState}`;
    if (update.run(reason, now(), review.id).changes === 1) {
      store.event(taskId, "review.aborted", { review_id: review.id, task_state: terminalState });
    }
  }
}

function requiredTask(store: StateStore, taskId: string): TaskRecord {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return task;
}
