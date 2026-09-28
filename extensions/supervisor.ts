import path from "node:path";
import { openSwitchYard } from "../src/context.ts";
import { markDelivered, startWakePump } from "../src/inbox.ts";
import { addProject, cloneProject, isRemoteGitUrl } from "../src/projects.ts";
import { reconcile } from "../src/reconcile.ts";
import { quiesceTaskRuntimes, startWorker, wakeWorker } from "../src/runtime.ts";
import type { MessageRecord, ProjectRecord, TaskKind, TaskRecord } from "../src/state.ts";
import {
  cancelTask,
  createTask,
  createTransientInvestigation,
  failTask,
  resolveDecision,
  reviewPolicyForTask,
  startTask,
  steerTask,
} from "../src/tasks.ts";
import type { PiExtensionApi } from "./pi-types.ts";
import { booleanSchema, enumSchema, objectSchema, stringSchema } from "./schema.ts";

interface DelegateParams {
  project: string;
  kind: TaskKind;
  instruction: string;
  review?: boolean;
  project_name?: string;
  project_location?: string;
  remote_action?: "clone" | "review_only";
}

interface TaskParams {
  task: string;
}

interface SendMessageParams extends TaskParams {
  text: string;
}

interface ResolveDecisionParams extends TaskParams {
  answer: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const SUPERVISOR_TOOLS = [
  "switchyard_delegate",
  "switchyard_list_tasks",
  "switchyard_get_task",
  "switchyard_send_message",
  "switchyard_resolve_decision",
  "switchyard_cancel_task",
];

export default function supervisorExtension(pi: PiExtensionApi) {
  let stopWakePump: (() => void) | undefined;
  let delivering = false;
  const awaitingConsumption = new Set<string>();
  const result = (value: unknown) => {
    const safeValue = redactInternalIds(value);
    return {
      content: [
        {
          type: "text",
          text: typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue, null, 2),
        },
      ],
      details: safeValue,
    };
  };

  pi.registerTool({
    name: "switchyard_delegate",
    label: "Delegate task",
    description:
      "Delegate by a registered Project name. Review is enabled by default for implementation Tasks; investigation Tasks are not reviewed. Unknown remote URLs require explicit clone or review-only intake.",
    parameters: objectSchema(
      {
        project: {
          ...stringSchema(),
          description:
            "Registered Project name, natural project reference, local checkout path, or remote Git URL.",
        },
        kind: enumSchema(["implement", "investigate"]),
        instruction: stringSchema(),
        review: {
          ...booleanSchema(),
          description: "Review implementation Tasks by default; false opts out.",
        },
        project_name: { ...stringSchema(), description: "Required to register a new Project." },
        project_location: {
          ...stringSchema(),
          description: "Existing checkout path or requested clone destination.",
        },
        remote_action: enumSchema(["clone", "review_only"]),
      },
      ["project", "kind", "instruction"],
    ),
    async execute(_id: string, params: DelegateParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const resolution = resolveProject(store.listProjects(), params.project);
        let project = resolution.project;
        if (resolution.matches) {
          return result({
            status: "ambiguous_project",
            message: "Several Projects match. Choose one by its name or checkout location.",
            matches: resolution.matches.map(projectView),
          });
        }

        if (!project && isRemoteGitUrl(params.project)) {
          if (params.remote_action === "review_only") {
            if (params.kind !== "investigate") {
              return result({
                status: "project_intake_required",
                project: params.project,
                message:
                  "Implementation requires a registered Project. Choose clone with a Project name and destination; review-only supports investigation Tasks.",
                required_for_clone: ["project_name", "project_location"],
              });
            }
            reviewPolicyForTask(params.kind, params.review);
            const task = createTransientInvestigation(
              store,
              paths,
              params.project,
              params.instruction,
            );
            try {
              await startTask(store, paths, task.id);
              await startWorker(store, paths, task.id);
            } catch (error) {
              const current = store.getTask(task.id);
              if (current && (current.state === "queued" || current.state === "starting")) {
                failTask(
                  store,
                  task.id,
                  `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                await quiesceTaskRuntimes(store, task.id);
              }
            }
            const finalTask = store.getTask(task.id) ?? task;
            return result({
              status: finalTask.state === "failed" ? "task_failed" : "task_started",
              source: params.project,
              registered: false,
              task_started: finalTask.state === "running",
              task: taskView(store, finalTask),
            });
          }
          if (params.remote_action !== "clone") {
            return result({
              status: "project_intake_required",
              project: params.project,
              question: "Should SwitchYard clone this remote, or leave it review-only?",
              choices: ["clone", "review_only"],
              required_for_clone: ["project_name", "project_location"],
            });
          }
          if (!params.project_name?.trim() || !params.project_location?.trim()) {
            return result({
              status: "project_intake_required",
              project: params.project,
              action: "clone",
              required: ["project_name", "project_location"],
              message: "Cloning requires the Project name and local destination.",
            });
          }
          project = await cloneProject(
            store,
            paths,
            params.project,
            params.project_name,
            params.project_location,
          );
        } else if (!project) {
          if (!params.project_name?.trim() || !params.project_location?.trim()) {
            return result({
              status: "project_intake_required",
              project: params.project,
              question:
                "This Project is not registered. Is it an existing local checkout? If so, provide its display name and checkout location.",
              required: ["project_name", "project_location"],
            });
          }
          if (params.remote_action) {
            return result({
              status: "invalid_project_intake",
              message: "Choose clone or review-only only when project is a remote Git URL.",
            });
          }
          project = await addProject(store, paths, params.project_location, params.project_name);
        }

        const task = createTask(
          store,
          project.id,
          params.kind,
          params.instruction,
          reviewPolicyForTask(params.kind, params.review),
        );
        try {
          await startTask(store, paths, task.id);
          await startWorker(store, paths, task.id);
        } catch (error) {
          const current = store.getTask(task.id);
          if (current && (current.state === "queued" || current.state === "starting")) {
            failTask(
              store,
              task.id,
              `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            await quiesceTaskRuntimes(store, task.id);
          }
        }
        return result(taskView(store, store.getTask(task.id) ?? task));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_list_tasks",
    label: "List tasks",
    description:
      "List durable Tasks by Project name, task description, and state. Internal IDs are omitted.",
    parameters: objectSchema({}),
    async execute() {
      const { store } = await openSwitchYard();
      try {
        return result(store.listTasks().map((task) => taskView(store, task)));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_get_task",
    label: "Get task",
    description:
      "Inspect a Task by Project name or a natural phrase from its instruction or summary.",
    parameters: objectSchema({ task: stringSchema() }, ["task"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        return result(match.task ? taskView(store, match.task) : taskResolutionView(store, match));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_send_message",
    label: "Steer task",
    description: "Persist steering for a Task identified by its Project and natural description.",
    parameters: objectSchema({ task: stringSchema(), text: stringSchema() }, ["task", "text"]),
    async execute(_id: string, params: SendMessageParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const task = steerTask(store, match.task.id, params.text);
        await wakeWorker(store, paths, task.id);
        return result(taskView(store, task));
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_resolve_decision",
    label: "Resolve decision",
    description:
      "Answer the open Decision for a Task identified by its Project and natural description.",
    parameters: objectSchema({ task: stringSchema(), answer: stringSchema() }, ["task", "answer"]),
    async execute(_id: string, params: ResolveDecisionParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const decision = store.getOpenDecision(match.task.id);
        if (!decision) {
          return result({
            status: "no_open_decision",
            task: taskReference(store, match.task),
            message: "This Task has no open Decision to answer.",
          });
        }
        const task = resolveDecision(store, match.task.id, decision.id, params.answer);
        await wakeWorker(store, paths, task.id);
        return result(taskView(store, task));
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_cancel_task",
    label: "Cancel task",
    description:
      "Cancel a Task by its Project name or natural description while preserving its Workspace.",
    parameters: objectSchema({ task: stringSchema() }, ["task"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const task = cancelTask(store, match.task.id);
        await quiesceTaskRuntimes(store, task.id);
        return result(taskView(store, task));
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  async function acknowledgeSupervisorMessages() {
    const ids = [...awaitingConsumption];
    if (ids.length === 0) return;
    try {
      const { store } = await openSwitchYard();
      try {
        store.transaction(() => {
          for (const id of ids) markDelivered(store, id);
        });
      } finally {
        store.close();
      }
    } finally {
      for (const id of ids) awaitingConsumption.delete(id);
    }
  }

  async function deliverSupervisorMessages() {
    if (delivering) return;
    delivering = true;
    const queuedIds: string[] = [];
    try {
      const { paths, store } = await openSwitchYard();
      try {
        pi.setActiveTools(SUPERVISOR_TOOLS);
        await reconcile(store, paths);
        const rows = (
          store.db
            .prepare(
              "SELECT * FROM messages WHERE recipient='supervisor' AND state='pending' ORDER BY created_at, id",
            )
            .all() as unknown as MessageRecord[]
        ).filter((message) => !awaitingConsumption.has(message.id));
        if (rows.length === 0) return;
        for (const message of rows) {
          awaitingConsumption.add(message.id);
          queuedIds.push(message.id);
        }
        await pi.sendUserMessage(
          rows.map((row) => humanizeMessage(store, row)).join("\n\n---\n\n"),
          {
            deliverAs: "steer",
          },
        );
      } finally {
        store.close();
      }
    } catch (error) {
      for (const id of queuedIds) awaitingConsumption.delete(id);
      throw error;
    } finally {
      delivering = false;
    }
  }

  pi.on("tool_call", async (event) => {
    const toolName = (event as { toolName?: string } | undefined)?.toolName;
    if (!toolName || SUPERVISOR_TOOLS.includes(toolName)) return undefined;
    return { block: true, reason: "Supervisor authority is limited to SwitchYard control tools." };
  });

  pi.on("session_start", async () => {
    pi.setActiveTools(SUPERVISOR_TOOLS);
    const { paths, store } = await openSwitchYard();
    try {
      stopWakePump ??= startWakePump(
        paths.wake,
        "supervisor.wake",
        deliverSupervisorMessages,
        2000,
      );
    } finally {
      store.close();
    }
    await deliverSupervisorMessages();
  });
  pi.on("agent_settled", acknowledgeSupervisorMessages);
  pi.on("agent_end", deliverSupervisorMessages);
  pi.on("session_shutdown", async () => {
    stopWakePump?.();
    stopWakePump = undefined;
  });
}

function resolveProject(
  projects: ProjectRecord[],
  reference: string,
): { project?: ProjectRecord; matches?: ProjectRecord[] } {
  const value = reference.trim().toLocaleLowerCase();
  const named = projects.filter((project) => project.name.trim().toLocaleLowerCase() === value);
  const namedMatch = sole(named);
  if (namedMatch) return { project: namedMatch };
  if (named.length > 1) return { matches: named };
  const matchingPath = projects.filter(
    (project) => path.resolve(project.root_path) === path.resolve(reference),
  );
  const pathMatch = sole(matchingPath);
  if (pathMatch) return { project: pathMatch };
  if (matchingPath.length > 1) return { matches: matchingPath };
  const matchingRemote = projects.filter((project) => project.remote_url === reference);
  const remoteMatch = sole(matchingRemote);
  if (remoteMatch) return { project: remoteMatch };
  if (matchingRemote.length > 1) return { matches: matchingRemote };
  return {};
}

function resolveTask(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  reference: string,
): { task?: TaskRecord; matches?: TaskRecord[] } {
  const tasks = store.listTasks();
  const query = normalize(reference);
  if (!query) return { matches: [] };
  const byId = tasks.find((task) => task.id === reference.trim());
  if (byId) return { task: byId };
  const exact = tasks.filter((task) => {
    const summary = normalize(task.summary ?? "");
    const instruction = normalize(task.instruction);
    return normalize(taskTitle(task)) === query || summary === query || instruction === query;
  });
  const exactMatch = sole(exact);
  if (exactMatch) return { task: exactMatch };
  if (exact.length > 1) return { matches: exact };
  const terms = query.split(/\s+/).filter(Boolean);
  const matches = tasks.filter((task) => {
    const project = task.project_id ? store.getProject(task.project_id) : undefined;
    const haystack = normalize(
      `${project?.name ?? task.source_url ?? ""} ${taskTitle(task)} ${task.instruction} ${task.summary ?? ""}`,
    );
    return haystack.includes(query) || terms.every((term) => haystack.includes(term));
  });
  const match = sole(matches);
  if (match) return { task: match };
  return { matches };
}

function sole<T>(values: T[]): T | undefined {
  return values.length === 1 ? values.at(0) : undefined;
}

function taskResolutionView(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  match: { matches?: TaskRecord[] },
) {
  if (match.matches?.length) {
    return {
      status: "ambiguous_task",
      message:
        "Several Tasks match. Use the Project name and more words from the task description.",
      matches: match.matches.map((task) => taskView(store, task)),
    };
  }
  return {
    status: "task_not_found",
    message:
      "No Task matches that reference. Use switchyard_list_tasks to see Projects and task descriptions.",
  };
}

function taskView(store: Awaited<ReturnType<typeof openSwitchYard>>["store"], task: TaskRecord) {
  const project = task.project_id ? store.getProject(task.project_id) : undefined;
  const decision = store.getOpenDecision(task.id);
  const review = store.getLatestReview(task.id);
  const workspace = store.getWorkspace(task.id);
  return {
    project: project?.name ?? task.source_url ?? "Transient source",
    task: taskTitle(task),
    kind: task.kind,
    state: task.state,
    instruction: task.instruction,
    summary: task.summary,
    verification_summary: task.verification_summary,
    failure: task.failure,
    created_at: task.created_at,
    updated_at: task.updated_at,
    workspace: workspace ? (workspace.provisioned ? "ready" : "provisioning") : "not reserved",
    decision: decision
      ? {
          question: decision.question,
          context: decision.context,
          options: decision.options_json ? JSON.parse(decision.options_json) : null,
        }
      : null,
    review: review
      ? { state: review.state, candidate_sha: review.candidate_sha, summary: review.summary }
      : null,
  };
}

function taskTitle(task: TaskRecord): string {
  const value = task.title.replace(/\s+/g, " ").trim();
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function taskReference(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  task: TaskRecord,
): string {
  const project = task.project_id ? store.getProject(task.project_id) : undefined;
  return `${project?.name ?? task.source_url ?? "Transient source"} / ${taskTitle(task)}`;
}

function projectView(project: ProjectRecord) {
  return { name: project.name, location: project.root_path, remote: project.remote_url };
}

function humanizeMessage(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  message: MessageRecord,
): string {
  const task = message.task_id ? store.getTask(message.task_id) : undefined;
  const reference = task ? taskReference(store, task) : "SwitchYard";
  let text = message.text;
  if (task) text = text.replaceAll(task.id, reference);
  text = text.replace(UUID, "an internal identifier");
  return text.startsWith(reference) ? text : `${reference}: ${text}`;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function redactInternalIds(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID, "an internal identifier");
  if (Array.isArray(value)) return value.map(redactInternalIds);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactInternalIds(child)]),
    );
  }
  return value;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(UUID, "the referenced record");
}
