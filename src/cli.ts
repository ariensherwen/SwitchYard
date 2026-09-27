#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openSwitchYard } from "./context.ts";
import { type DoctorReport, runDoctor } from "./doctor.ts";
import { addProject } from "./projects.ts";
import { reconcile } from "./reconcile.ts";
import { startWorker, stopWorker, wakeWorker } from "./runtime.ts";
import { cancelTask, createTask, failTask, resolveDecision, resumeWaiting, startTask } from "./tasks.ts";
import { attachWindow, ensureSession, ensureWindow } from "./tmux.ts";
import { buildPiLaunch, shellCommand } from "./pi.ts";
import { canSafelyClean, removeWorktree } from "./worktree.ts";
import { enqueueMessage } from "./inbox.ts";

const HELP = `SwitchYard

Usage:
  switchyard
  switchyard doctor
  switchyard project add [path]
  switchyard project list
  switchyard task create <project-id> [--kind implement|investigate] [--review] <instruction>
  switchyard task list
  switchyard task show <task-id>
  switchyard task send <task-id> <message>
  switchyard task answer <task-id> <decision-id> <answer>
  switchyard task cancel <task-id>
  switchyard task attach <task-id>
  switchyard task clean <task-id>

Options:
  --help
  --version
`;

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
    await ensureSession();
    const launch = buildPiLaunch("supervisor", paths.supervisor, {
      SWITCHYARD_HOME: paths.home,
      SWITCHYARD_SUPERVISOR: "1",
    }, "You are the SwitchYard Supervisor. Delegate implementation to SwitchYard workers; do not edit worker workspaces directly.");
    await ensureWindow("supervisor", launch.cwd, shellCommand(launch));
    return await attachWindow("supervisor");
  } finally {
    store.close();
  }
}

async function handleProject(store: Awaited<ReturnType<typeof openSwitchYard>>["store"], paths: Awaited<ReturnType<typeof openSwitchYard>>["paths"], args: string[]): Promise<number> {
  if (args[0] === "add") {
    const project = await addProject(store, paths, args[1] ?? process.cwd());
    console.log(`${project.id}\t${project.root_path}`);
    return 0;
  }
  if (args[0] === "list") {
    for (const project of store.listProjects()) console.log(`${project.id}\t${project.root_path}`);
    return 0;
  }
  throw new Error("usage: switchyard project add [path] | switchyard project list");
}

async function handleTask(store: Awaited<ReturnType<typeof openSwitchYard>>["store"], paths: Awaited<ReturnType<typeof openSwitchYard>>["paths"], args: string[]): Promise<number> {
  const command = args[0];
  if (command === "create") {
    const parsed = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      strict: true,
      options: { kind: { type: "string", default: "implement" }, review: { type: "boolean", default: false } },
    });
    const [projectId, ...instructionParts] = parsed.positionals;
    if (!projectId || instructionParts.length === 0) throw new Error("task create requires <project-id> and <instruction>");
    if (parsed.values.kind !== "implement" && parsed.values.kind !== "investigate") throw new Error("--kind must be implement or investigate");
    if (!store.getProject(projectId)) throw new Error(`project not found: ${projectId}`);
    const task = createTask(store, projectId, parsed.values.kind, instructionParts.join(" "), parsed.values.review ? "loop" : "off");
    try {
      await startTask(store, paths, task.id);
      await startWorker(store, paths, task.id);
    } catch (error) {
      const current = store.getTask(task.id);
      if (current && current.state === "starting") {
        failTask(store, task.id, `worker startup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(task.id);
    return store.getTask(task.id)?.state === "failed" ? 1 : 0;
  }
  if (command === "list") {
    for (const task of store.listTasks()) console.log(`${task.id}\t${task.state}\t${task.kind}\t${task.project_id}`);
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
    console.log(JSON.stringify({ task, workspace, decision, review, events: store.listEvents(taskId) }, null, 2));
    return 0;
  }
  if (command === "send") {
    const message = args.slice(2).join(" ").trim();
    if (!message) throw new Error("task send requires <message>");
    if (["completed", "failed", "cancelled"].includes(task.state)) throw new Error("cannot send to a terminal task");
    if (task.state === "waiting") resumeWaiting(store, taskId, message);
    else enqueueMessage(store, taskId, "worker", message);
    await wakeWorker(store, taskId);
    return 0;
  }
  if (command === "answer") {
    const decisionId = args[2];
    const answer = args.slice(3).join(" ").trim();
    if (!decisionId || !answer) throw new Error("task answer requires <decision-id> <answer>");
    resolveDecision(store, taskId, decisionId, answer);
    await wakeWorker(store, taskId);
    return 0;
  }
  if (command === "cancel") {
    cancelTask(store, taskId);
    await stopWorker(store, taskId);
    const review = store.getLatestReview(taskId);
    if (review?.state === "running") {
      const { killWindow } = await import("./tmux.ts");
      await killWindow(review.tmux_window);
    }
    return 0;
  }
  if (command === "attach") {
    const worker = store.getActiveWorker(taskId);
    if (!worker) throw new Error("task has no active worker");
    return await attachWindow(worker.tmux_window);
  }
  if (command === "clean") {
    const workspace = store.getWorkspace(taskId);
    const project = store.getProject(task.project_id);
    if (!workspace || !project || !task.base_sha) throw new Error("task workspace is incomplete");
    if (!(await canSafelyClean(project.root_path, workspace.path, task.base_sha))) throw new Error("refusing cleanup: task has commits not landed in the registered Project HEAD");
    await removeWorktree(project.root_path, workspace.path);
    return 0;
  }
  throw new Error(`unknown task command: ${command}`);
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("package.json is missing a string version");
  return packageJson.version;
}

function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map((check) => {
    const detail = check.version ? (check.error ? `${check.version} (${check.error})` : check.version) : (check.error ?? "unavailable");
    return `${check.tool.padEnd(5)} ${check.ok ? "ok" : "fail"}  ${detail}`;
  });
  return `SwitchYard doctor\n\n${rows.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));

export { main };
