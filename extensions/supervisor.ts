import path from "node:path";
import { openSwitchYard } from "../src/context.ts";
import { markDelivered, startWakePump } from "../src/inbox.ts";
import { landCompletedTask } from "../src/landing.ts";
import {
  addProject,
  addProjectRemote,
  cloneProject,
  createProject,
  inspectProject,
  isRemoteGitUrl,
  listProjectRemotes,
  relocateProject,
  removeProjectRemote,
  renameProject,
  resolveUserPath,
  unregisterProject,
  updateProjectRemote,
  validateProjectCheckout,
} from "../src/projects.ts";
import { publishCompletedTask } from "../src/publish.ts";
import { reconcile } from "../src/reconcile.ts";
import { quiesceTaskRuntimes, startWorker, wakeWorker } from "../src/runtime.ts";
import type {
  MessageRecord,
  ProjectRecord,
  ReviewRecord,
  TaskKind,
  TaskRecord,
} from "../src/state.ts";
import {
  cancelTask,
  createTask,
  createTransientInvestigation,
  failTask,
  resolveDecision,
  reviewPolicyForTask,
  startTask,
  steerTask,
  updateTaskTitle,
} from "../src/tasks.ts";
import { showWindowReadOnly } from "../src/tmux.ts";
import { projectHasChanges, resolveRemoteRevision } from "../src/worktree.ts";
import type { PiExtensionApi } from "./pi-types.ts";
import {
  booleanSchema,
  enumSchema,
  objectSchema,
  stringArraySchema,
  stringSchema,
} from "./schema.ts";

interface DelegateParams {
  project: string;
  kind: TaskKind;
  instruction: string;
  title?: string;
  review?: boolean;
  base_ref?: string;
  use_committed_head?: boolean;
  source_label?: string;
  source_revision?: string;
  source_ref?: string;
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
    name: "switchyard_list_projects",
    label: "List Projects",
    description:
      "List registered and historical Projects with local paths, Git remotes, registration state, and recent Task summaries.",
    parameters: objectSchema({}),
    async execute() {
      const { store } = await openSwitchYard();
      try {
        return result(
          await Promise.all(
            store.listAllProjects().map((project) => projectDetails(store, project)),
          ),
        );
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_get_project",
    label: "Inspect Project",
    description:
      "Inspect a Project by exact display name or local path. Ask if the name is ambiguous.",
    parameters: objectSchema({ project: stringSchema() }, ["project"]),
    async execute(_id: string, params: { project: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listAllProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        return result(await projectDetails(store, match.project));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_register_project",
    label: "Register local Project",
    description:
      "Register an existing local Git checkout. This operation never runs git init. Confirm identity replacement only after the human approves adopting a different repository at a registered path.",
    parameters: objectSchema(
      {
        location: stringSchema(),
        name: stringSchema(),
        confirm_identity_change: booleanSchema(),
      },
      ["location"],
    ),
    async execute(
      _id: string,
      params: { location: string; name?: string; confirm_identity_change?: boolean },
    ) {
      const { paths, store } = await openSwitchYard();
      try {
        const project = await addProject(store, paths, params.location, params.name, {
          ...(params.confirm_identity_change !== undefined
            ? { confirmIdentityChange: params.confirm_identity_change }
            : {}),
        });
        return result(await projectDetails(store, project));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_create_project",
    label: "Create local Project",
    description:
      "Create a directory, initialize Git, and register an empty Project. Workers create project contents.",
    parameters: objectSchema({ name: stringSchema(), location: stringSchema() }, [
      "name",
      "location",
    ]),
    async execute(_id: string, params: { name: string; location: string }) {
      const { paths, store } = await openSwitchYard();
      try {
        const project = await createProject(store, paths, params.name, params.location);
        return result(await projectDetails(store, project));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_rename_project",
    label: "Rename Project",
    description: "Change only a Project's display name; do not rename its checkout or Git remotes.",
    parameters: objectSchema({ project: stringSchema(), name: stringSchema() }, [
      "project",
      "name",
    ]),
    async execute(_id: string, params: { project: string; name: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listAllProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        return result(
          await projectDetails(store, await renameProject(store, match.project.id, params.name)),
        );
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_unregister_project",
    label: "Unregister Project",
    description:
      "Stop offering a Project for new work without deleting its checkout or history. Refuses active Tasks.",
    parameters: objectSchema({ project: stringSchema() }, ["project"]),
    async execute(_id: string, params: { project: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listAllProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        return result(await projectDetails(store, unregisterProject(store, match.project.id)));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_relocate_project",
    label: "Relocate Project",
    description: "Move a Project checkout when no nonterminal Task depends on it.",
    parameters: objectSchema({ project: stringSchema(), location: stringSchema() }, [
      "project",
      "location",
    ]),
    async execute(_id: string, params: { project: string; location: string }) {
      const { paths, store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listAllProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        return result(
          await projectDetails(
            store,
            await relocateProject(store, paths, match.project.id, params.location),
          ),
        );
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_list_remotes",
    label: "List Git remotes",
    description: "Read Git fetch and push URLs from the registered checkout's Git configuration.",
    parameters: objectSchema({ project: stringSchema() }, ["project"]),
    async execute(_id: string, params: { project: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        return result({
          project: projectReference(match.project),
          remotes: await listProjectRemotes(store, match.project.id),
        });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_add_remote",
    label: "Add Git remote",
    description: "Add one named Git remote to the registered checkout.",
    parameters: objectSchema(
      { project: stringSchema(), name: stringSchema(), url: stringSchema() },
      ["project", "name", "url"],
    ),
    async execute(_id: string, params: { project: string; name: string; url: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        await addProjectRemote(store, match.project.id, params.name, params.url);
        return result({
          project: projectReference(match.project),
          remotes: await listProjectRemotes(store, match.project.id),
        });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_update_remote",
    label: "Update Git remote",
    description: "Update one fetch or push URL without changing other Git remotes.",
    parameters: objectSchema(
      {
        project: stringSchema(),
        name: stringSchema(),
        url: stringSchema(),
        direction: enumSchema(["fetch", "push"]),
      },
      ["project", "name", "url"],
    ),
    async execute(
      _id: string,
      params: { project: string; name: string; url: string; direction?: "fetch" | "push" },
    ) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        await updateProjectRemote(
          store,
          match.project.id,
          params.name,
          params.url,
          params.direction,
        );
        return result({
          project: projectReference(match.project),
          remotes: await listProjectRemotes(store, match.project.id),
        });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_remove_remote",
    label: "Remove Git remote",
    description: "Remove one named Git remote from the registered checkout.",
    parameters: objectSchema({ project: stringSchema(), name: stringSchema() }, [
      "project",
      "name",
    ]),
    async execute(_id: string, params: { project: string; name: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveProject(store.listProjects(), params.project);
        if (!match.project) return result(projectResolutionView(match));
        await removeProjectRemote(store, match.project.id, params.name);
        return result({
          project: projectReference(match.project),
          remotes: await listProjectRemotes(store, match.project.id),
        });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_resolve_remote_revision",
    label: "Resolve remote Git ref",
    description:
      "Resolve a concrete remote Git ref to one commit SHA before transient inspection. This uses Git only and does not register the source.",
    parameters: objectSchema({ remote: stringSchema(), ref: stringSchema() }, ["remote", "ref"]),
    async execute(_id: string, params: { remote: string; ref: string }) {
      try {
        return result({
          remote: params.remote,
          ref: params.ref,
          revision: await resolveRemoteRevision(params.remote, params.ref),
        });
      } catch (error) {
        throw new Error(publicError(error));
      }
    },
  });

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
        title: { ...stringSchema(), description: "Short human-facing Task title." },
        base_ref: {
          ...stringSchema(),
          description: "Explicit Git ref to capture as the immutable Task base.",
        },
        use_committed_head: {
          ...booleanSchema(),
          description:
            "Explicit acknowledgement that dirty local changes remain untouched and the Task uses committed HEAD.",
        },
        source_label: {
          ...stringSchema(),
          description: "Human source reference such as Foo PR #42.",
        },
        source_revision: {
          ...stringSchema(),
          description: "Full commit SHA for transient inspection; required for remote-only work.",
        },
        source_ref: {
          ...stringSchema(),
          description: "The remote Git ref used to fetch the pinned commit.",
        },
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
            if (!params.source_revision) {
              return result({
                status: "source_revision_required",
                source: params.source_label ?? params.project,
                message:
                  "Resolve the requested remote ref to a concrete commit SHA before starting transient work.",
              });
            }
            const task = await createTransientInvestigation(
              store,
              paths,
              params.project,
              params.instruction,
              params.title ?? params.instruction,
              params.source_label ?? params.project,
              params.source_revision,
              params.source_ref,
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
                await quiesceTaskRuntimes(store, task.id, {}, paths);
              }
            }
            const finalTask = store.getTask(task.id) ?? task;
            return result({
              status: finalTask.state === "failed" ? "task_failed" : "task_started",
              source: params.source_label ?? params.project,
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

        const projectRoot = await validateProjectCheckout(store, project);
        if ((await projectHasChanges(projectRoot)) && !params.use_committed_head) {
          return result({
            status: "dirty_project_confirmation",
            project: project.name,
            path: projectRoot,
            message: `${project.name} has uncommitted local changes. Confirm that work should start from committed HEAD and those changes must remain untouched.`,
            branch: (await inspectProject(store, project.id)).branch,
          });
        }

        const task = createTask(
          store,
          project.id,
          params.kind,
          params.instruction,
          reviewPolicyForTask(params.kind, params.review),
          params.title ?? params.instruction,
          {
            ...(params.base_ref ? { baseRef: params.base_ref } : {}),
            dirtyAcknowledged: params.use_committed_head ?? false,
          },
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
            await quiesceTaskRuntimes(store, task.id, {}, paths);
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
        const wasReviewing = match.task.state === "reviewing";
        const task = steerTask(store, match.task.id, params.text);
        if (!wasReviewing) await wakeWorker(store, paths, task.id);
        return result({
          ...taskView(store, task),
          steering: wasReviewing
            ? "queued until the active Review reaches its safe boundary"
            : "delivered to the Worker",
        });
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
      const { paths, store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const task = cancelTask(store, match.task.id);
        await quiesceTaskRuntimes(store, task.id, {}, paths);
        return result(taskView(store, task));
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_rename_task",
    label: "Rename Task",
    description:
      "Change a Task's human-facing title without changing its internal identity or lifecycle state.",
    parameters: objectSchema({ task: stringSchema(), title: stringSchema() }, ["task", "title"]),
    async execute(_id: string, params: { task: string; title: string }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        return result(taskView(store, updateTaskTitle(store, match.task.id, params.title)));
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_land_task",
    label: "Land completed Task",
    description:
      "Fast-forward a completed candidate into its registered Project only after explicit human intent. Refuses dirty or diverged targets.",
    parameters: objectSchema({ task: stringSchema() }, ["task"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const landed = await landCompletedTask(store, match.task.id);
        if (landed.status === "diverged") {
          return result({
            status: landed.status,
            project: landed.project,
            branch: landed.branch,
            message: `${landed.project} advanced beyond this Task's base. Do not merge or rebase automatically; offer a follow-up integration Task based on the current target.`,
          });
        }
        return result({
          status: landed.status,
          project: landed.project,
          branch: landed.branch,
          workspace: landed.workspace,
        });
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_publish_task",
    label: "Publish completed candidate",
    description:
      "Push the exact completed candidate to human-selected Git remote(s) under a named branch. This does not open or merge a PR.",
    parameters: objectSchema(
      {
        task: stringSchema(),
        branch: stringSchema(),
        remotes: stringArraySchema(),
      },
      ["task", "branch"],
    ),
    async execute(_id: string, params: { task: string; branch: string; remotes?: string[] }) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const publication = await publishCompletedTask(
          store,
          match.task.id,
          params.branch,
          params.remotes,
        );
        const failed = publication.targets.filter((target) => target.status === "failed");
        return result({
          project: publication.project,
          branch: publication.branch,
          targets: publication.targets,
          status:
            failed.length === 0
              ? "published"
              : failed.length === publication.targets.length
                ? "failed"
                : "partial",
        });
      } catch (error) {
        throw new Error(publicError(error));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_show_worker",
    label: "Show Worker",
    description:
      "Open a live, read-only tmux popup showing the Worker pane. Press q in the popup to return; input is never sent to the Worker.",
    parameters: objectSchema({ task: stringSchema() }, ["task"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const worker = store.getLiveWorker(match.task.id);
        if (!worker)
          return result({ status: "no_live_worker", task: taskReference(store, match.task) });
        await showWindowReadOnly(worker.tmux_window);
        return result({ status: "worker_viewed", task: taskReference(store, match.task) });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_show_reviewer",
    label: "Show Reviewer",
    description:
      "Open a live, read-only tmux popup showing the Reviewer pane. Press q in the popup to return; input is never sent to the Reviewer.",
    parameters: objectSchema({ task: stringSchema() }, ["task"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const match = resolveTask(store, params.task);
        if (!match.task) return result(taskResolutionView(store, match));
        const review = store.getLatestReview(match.task.id);
        if (review?.state !== "running")
          return result({ status: "no_active_reviewer", task: taskReference(store, match.task) });
        await showWindowReadOnly(review.tmux_window);
        return result({ status: "reviewer_viewed", task: taskReference(store, match.task) });
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

  pi.on("session_start", async () => {
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
  const trimmed = reference.trim();
  const byId = projects.find((project) => project.id === trimmed);
  if (byId) return { project: byId };
  const value = trimmed.toLocaleLowerCase();
  const named = projects.filter((project) => project.name.trim().toLocaleLowerCase() === value);
  const namedMatch = sole(named);
  if (namedMatch) return { project: namedMatch };
  if (named.length > 1) return { matches: named };
  const matchingPath = projects.filter(
    (project) => path.resolve(project.root_path) === resolveUserPath(reference),
  );
  const pathMatch = sole(matchingPath);
  if (pathMatch) return { project: pathMatch };
  if (matchingPath.length > 1) return { matches: matchingPath };
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
      `${project?.name ?? task.source_label ?? task.source_url ?? ""} ${taskTitle(task)} ${task.instruction} ${task.summary ?? ""}`,
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
  return {
    project: project?.name ?? task.source_label ?? "Transient source",
    task: taskTitle(task),
    kind: task.kind === "implement" ? "Implementation" : "Investigation",
    status: taskStatus(task.state),
    instruction: task.instruction,
    summary: task.summary,
    verification_summary: task.verification_summary,
    failure: task.failure,
    decision: decision
      ? {
          question: decision.question,
          context: decision.context,
          options: decision.options_json ? JSON.parse(decision.options_json) : null,
        }
      : null,
    review: review ? { status: reviewStatus(review.state), summary: review.summary } : null,
  };
}

function taskStatus(state: TaskRecord["state"]): string {
  return {
    queued: "Queued",
    starting: "Starting",
    running: "Working",
    waiting: "Waiting for input",
    needs_decision: "Needs your decision",
    reviewing: "Under implementation review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }[state];
}

function reviewStatus(state: ReviewRecord["state"]): string {
  return {
    running: "Under review",
    changes_requested: "Changes requested",
    clean: "Passed",
    failed: "Failed",
  }[state];
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
  return `${project?.name ?? task.source_label ?? "Transient source"} / ${taskTitle(task)}`;
}

function projectView(project: ProjectRecord) {
  return {
    name: project.name,
    location: project.root_path,
    registration_state: project.registration_state,
  };
}

function projectReference(project: ProjectRecord): string {
  return `${project.name} (${project.root_path})`;
}

function projectResolutionView(match: { matches?: ProjectRecord[] }) {
  if (match.matches?.length) {
    return {
      status: "ambiguous_project",
      message: "Several Projects have that display name. Choose one by its local path.",
      matches: match.matches.map(projectView),
    };
  }
  return {
    status: "project_not_found",
    message: "No Project matches that exact name or local path.",
  };
}

async function projectDetails(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  project: ProjectRecord,
) {
  const recent_tasks = store
    .listTasks()
    .filter((task) => task.project_id === project.id)
    .slice(0, 4)
    .map((task) => ({
      title: taskTitle(task),
      kind: task.kind === "implement" ? "Implementation" : "Investigation",
      status: taskStatus(task.state),
      summary: task.summary,
    }));
  if (project.registration_state !== "registered") return { ...projectView(project), recent_tasks };
  try {
    const facts = await inspectProject(store, project.id);
    return {
      ...projectView(facts.project),
      branch: facts.branch,
      dirty: facts.dirty,
      changes: facts.changes,
      remotes: facts.remotes,
      recent_tasks,
    };
  } catch (error) {
    return {
      ...projectView(project),
      checkout_error: publicError(error),
      recent_tasks,
    };
  }
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
