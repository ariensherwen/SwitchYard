#!/usr/bin/env node

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openSwitchYard } from "./context.ts";
import { type DoctorReport, runDoctor } from "./doctor.ts";
import { buildPiLaunch, shellCommand } from "./pi.ts";
import { addProject, resolveUserPath } from "./projects.ts";
import { reconcile } from "./reconcile.ts";
import { quiesceTaskRuntimes, startWorker, wakeWorker } from "./runtime.ts";
import {
  cancelTask,
  createTask,
  failTask,
  markWorkspaceCleaned,
  resolveDecision,
  reviewPolicyForTask,
  startTask,
  steerTask,
  taskSourceRoot,
} from "./tasks.ts";
import { attachWindow, captureWindow, ensureWindow } from "./tmux.ts";
import { canSafelyClean, canSafelyCleanTransient, removeWorktree } from "./worktree.ts";

const HELP = `SwitchYard

Usage:
  switchyard                         Talk to the Supervisor
  switchyard doctor                  Check local dependencies
  switchyard recover                 Reconcile durable state and runtimes
  switchyard project add [path]      Register an existing Git checkout
  switchyard project list            List registered Projects
  switchyard task create <project> [--kind implement|investigate] [--no-review] <instruction>
  switchyard task list [--json]      List recent work
  switchyard task show <task-id>     Inspect durable state (debug)
  switchyard task send <task-id> <message>
  switchyard task answer <task-id> <decision-id> <answer>
  switchyard task cancel <task-id>
  switchyard task attach <task-id>   Capture the Worker pane
  switchyard task clean <task-id>

Machine output:
  Add --json to project add/list or task create/list to include internal IDs.

Options:
  --help
  --version
`;

const SUPERVISOR_PROMPT = [
  "You are SwitchYard's global liaison. Work from registered Project and Task records, never assume the launch directory is a Project. The initial launch directory is only context for explicitly relative paths; ask for an absolute path if the intended checkout is unclear.",
  "Keep human conversation focused on Project names, Task titles, Decisions, and useful progress. Never show internal UUIDs, commit hashes, raw lifecycle state names, or database plumbing; translate progress into plain language.",
  "Use SwitchYard control tools only. Delegate implementation to Workers; do not edit repositories or task Workspaces yourself. Implementation Tasks use the review loop by default; investigation Tasks are read-only and never reviewed.",
  "Before starting work in a dirty Project checkout, ask whether to leave local changes untouched and use committed HEAD. Capture the chosen base ref and never move an existing Task to a different revision.",
  "Unknown local checkouts require registration details. Unknown remotes require an explicit choice: clone and register for implementation, or inspect a concrete pinned commit as a transient investigation without registration. Resolve remote refs to a full commit SHA before investigation and preserve the selected ref as context.",
  "Completion is not landing or publishing. Do not change the Project branch, push, open a PR, or merge unless the human explicitly asks. Landing fast-forwards the current Project branch only and refuses dirty or advanced targets; never resolve divergence automatically. Publishing pushes only the exact candidate to human-named Git remote(s) and branch; ask for any missing target and do not invent one. SwitchYard has no forge tool: publishing does not open or merge a PR.",
  "If a completed Task cannot be landed because its Project advanced, explain the conflict and offer a separate integration Task based on the current Project state. Do not create that follow-up without the human's agreement.",
].join("\n\n");

async function main(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes("--version")) {
    console.log(await readPackageVersion());
    return 0;
  }
  if (args[0] === "doctor") {
    const report = await runDoctor();
    process.stdout.write(formatDoctorReport(report));
    return report.ok ? 0 : 1;
  }
  if (args.length === 0) return await launchSupervisor();

  try {
    const { paths, store } = await openSwitchYard();
    try {
      if (args[0] === "recover") {
        await reconcile(store, paths);
        console.log("Recovery complete.");
        return 0;
      }
      if (args[0] === "project") return await handleProject(store, paths, args.slice(1));
      if (args[0] === "task") return await handleTask(store, paths, args.slice(1));
      console.error(`Unknown command: ${args[0]}`);
      return 1;
    } finally {
      store.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function launchSupervisor(): Promise<number> {
  const { paths, store } = await openSwitchYard();
  try {
    await reconcile(store, paths);
    const launch = buildPiLaunch(
      "supervisor",
      paths.supervisor,
      {
        SWITCHYARD_HOME: paths.home,
        SWITCHYARD_SUPERVISOR: "1",
        SWITCHYARD_LAUNCH_CWD: process.cwd(),
      },
      SUPERVISOR_PROMPT,
    );
    await ensureWindow("supervisor", launch.cwd, shellCommand(launch));
    return await attachWindow("supervisor");
  } finally {
    store.close();
  }
}

async function handleProject(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  paths: Awaited<ReturnType<typeof openSwitchYard>>["paths"],
  args: string[],
): Promise<number> {
  if (args[0] === "add") {
    const location = args.slice(1).find((value) => value !== "--json") ?? process.cwd();
    const project = await addProject(store, paths, location);
    console.log(
      args.includes("--json")
        ? JSON.stringify(project)
        : `Registered ${project.name} at ${project.root_path}`,
    );
    return 0;
  }
  if (args[0] === "list") {
    const projects = store.listProjects();
    if (args.includes("--json")) console.log(JSON.stringify(projects, null, 2));
    else for (const project of projects) console.log(`${project.name}\t${project.root_path}`);
    return 0;
  }
  throw new Error("usage: switchyard project add [path] | switchyard project list");
}

async function handleTask(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  paths: Awaited<ReturnType<typeof openSwitchYard>>["paths"],
  args: string[],
): Promise<number> {
  const command = args[0];
  if (command === "create") {
    const parsed = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      strict: true,
      options: {
        kind: { type: "string", default: "implement" },
        review: { type: "boolean" },
        "no-review": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    const [projectReference, ...instructionParts] = parsed.positionals;
    if (!projectReference || instructionParts.length === 0)
      throw new Error("task create requires <project> and <instruction>");
    const project = resolveProjectArgument(store, projectReference);
    if (parsed.values.kind !== "implement" && parsed.values.kind !== "investigate")
      throw new Error("--kind must be implement or investigate");
    if (parsed.values.kind === "investigate" && args.slice(1).includes("--review"))
      throw new Error("--review is supported only for implement tasks");
    const task = createTask(
      store,
      project.id,
      parsed.values.kind,
      instructionParts.join(" "),
      reviewPolicyForTask(parsed.values.kind, parsed.values["no-review"] ? false : undefined),
    );
    try {
      await startTask(store, paths, task.id);
      const current = store.getTask(task.id);
      if (current?.state === "starting" && store.getWorkspace(task.id)?.provisioned === 1)
        await startWorker(store, paths, task.id);
    } catch (error) {
      const current = store.getTask(task.id);
      if (current && (current.state === "queued" || current.state === "starting")) {
        failTask(
          store,
          task.id,
          `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const finalTask = store.getTask(task.id) ?? task;
    if (parsed.values.json) {
      console.log(JSON.stringify({ task: finalTask, project: project.name }, null, 2));
    } else {
      console.log(`${project.name} / ${finalTask.title}: ${finalTask.state}`);
    }
    return finalTask.state === "failed" ? 1 : 0;
  }
  if (command === "list") {
    const tasks = store.listTasks();
    if (args.includes("--json")) {
      console.log(JSON.stringify(tasks, null, 2));
    } else {
      for (const task of tasks) {
        const project = task.project_id ? store.getProject(task.project_id) : undefined;
        console.log(
          `${project?.name ?? task.source_label ?? "Transient source"}\t${task.title}\t${task.state}\t${task.kind}`,
        );
      }
    }
    return 0;
  }
  const taskId = args[1];
  if (!taskId) throw new Error(`task ${command ?? ""} requires <task-id>`);
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (command === "show") {
    const workspace = store.getWorkspace(taskId);
    const decision = store.getOpenDecision(taskId);
    const review = store.getLatestReview(taskId);
    console.log(
      JSON.stringify(
        { task, workspace, decision, review, events: store.listEvents(taskId) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === "send") {
    const message = args.slice(2).join(" ").trim();
    if (!message) throw new Error("task send requires <message>");
    const current = steerTask(store, taskId, message);
    if (current.state !== "reviewing") await wakeWorker(store, paths, taskId);
    return 0;
  }
  if (command === "answer") {
    const decisionId = args[2];
    const answer = args.slice(3).join(" ").trim();
    if (!decisionId || !answer) throw new Error("task answer requires <decision-id> <answer>");
    resolveDecision(store, taskId, decisionId, answer);
    await wakeWorker(store, paths, taskId);
    return 0;
  }
  if (command === "cancel") {
    cancelTask(store, taskId);
    await quiesceTaskRuntimes(store, taskId, {}, paths);
    return 0;
  }
  if (command === "attach") {
    const worker = store.getActiveWorker(taskId);
    if (!worker) throw new Error("task has no active worker");
    process.stdout.write(await captureWindow(worker.tmux_window));
    return 0;
  }
  if (command === "clean") {
    if (!["completed", "failed", "cancelled"].includes(task.state)) {
      throw new Error(
        `refusing cleanup: task is ${task.state}; only terminal Tasks can be cleaned`,
      );
    }
    const workspace = store.getWorkspace(taskId);
    if (!workspace || !task.base_sha) throw new Error("task workspace is incomplete");
    const sourceRoot = taskSourceRoot(store, task);
    if (task.source_path) {
      const expectedSource = path.resolve(paths.sources, task.id);
      if (path.resolve(task.source_path) !== expectedSource)
        throw new Error("refusing cleanup: transient source path is outside the SwitchYard home");
      if (!(await canSafelyCleanTransient(sourceRoot, workspace.path, task.base_sha))) {
        throw new Error(
          "refusing cleanup: transient source or task Workspace contains uncommitted work",
        );
      }
      await removeWorktree(sourceRoot, workspace.path);
      await rm(sourceRoot, { recursive: true });
    } else {
      if (!(await canSafelyClean(sourceRoot, workspace.path, task.base_sha))) {
        throw new Error(
          "refusing cleanup: workspace is dirty or contains commits not landed in the registered Project HEAD",
        );
      }
      await removeWorktree(sourceRoot, workspace.path);
    }
    markWorkspaceCleaned(store, taskId);
    return 0;
  }
  throw new Error(`unknown task command: ${command}`);
}

function resolveProjectArgument(
  store: Awaited<ReturnType<typeof openSwitchYard>>["store"],
  reference: string,
) {
  const direct = store.getProject(reference);
  if (direct?.registration_state === "registered") return direct;
  const projects = store.listProjects();
  const named = projects.filter(
    (project) => project.name.toLocaleLowerCase() === reference.trim().toLocaleLowerCase(),
  );
  if (named.length === 1) {
    const project = named[0];
    if (project) return project;
  }
  if (named.length > 1)
    throw new Error(
      `Project name is ambiguous; use its local path: ${named.map((project) => project.root_path).join(", ")}`,
    );
  const target = resolveUserPath(reference);
  const matchingPath = projects.find((project) => project.root_path === target);
  if (matchingPath) return matchingPath;
  throw new Error(`registered Project not found: ${reference}`);
}

async function readPackageVersion(): Promise<string> {
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = JSON.parse(
        await readFile(new URL(relative, import.meta.url), "utf8"),
      ) as {
        version?: unknown;
      };
      if (typeof packageJson.version !== "string") {
        throw new Error("package.json is missing a string version");
      }
      return packageJson.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error("package.json not found");
}

function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map((check) => {
    const detail = check.version
      ? check.error
        ? `${check.version} (${check.error})`
        : check.version
      : (check.error ?? "unavailable");
    return `${check.tool.padEnd(5)} ${check.ok ? "ok" : "fail"}  ${detail}`;
  });
  return `SwitchYard doctor\n\n${rows.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = await main(process.argv.slice(2));

export { main };
