import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import type { PiExtensionApi, PiLifecycleEvent, PiToolDefinition } from "../extensions/pi-types.ts";
import reviewerExtension from "../extensions/reviewer.ts";
import supervisorExtension from "../extensions/supervisor.ts";
import workerExtension from "../extensions/worker.ts";
import { ensureSwitchYardHome } from "../src/home.ts";
import { enqueueMessage, signalWake } from "../src/inbox.ts";
import { now, StateStore } from "../src/state.ts";
import { createTask, transition } from "../src/tasks.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...savedEnv };
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(state: "running" | "waiting" = "running") {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-ext-"));
  dirs.push(root);
  const paths = await ensureSwitchYardHome({
    ...process.env,
    SWITCHYARD_HOME: path.join(root, "home"),
  });
  process.env.SWITCHYARD_HOME = paths.home;
  const store = new StateStore(paths.database);
  store.db
    .prepare("INSERT INTO projects(id, name, root_path, created_at) VALUES ('p', 'sample', ?, ?)")
    .run(root, now());
  const task = createTask(store, "p", "implement", "Do the durable instruction", "off");
  transition(store, task.id, "queued", "starting", "task.starting");
  transition(store, task.id, "starting", "running", "task.started");
  if (state === "waiting") transition(store, task.id, "running", "waiting", "task.waiting");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  store.db
    .prepare("INSERT INTO workspaces(task_id, path, branch, created_at) VALUES (?, ?, ?, ?)")
    .run(task.id, workspace, `switchyard/task-${task.id}`, now());
  const workerId = "worker-1";
  store.db
    .prepare(
      "INSERT INTO workers(id, task_id, state, tmux_window, created_at) VALUES (?, ?, 'active', ?, ?)",
    )
    .run(workerId, task.id, `task-${task.id}`, now());
  return { paths, store, taskId: task.id, workerId };
}

function fakePi() {
  const tools = new Map<string, unknown>();
  const handlers = new Map<PiLifecycleEvent, Parameters<PiExtensionApi["on"]>[1]>();
  const messages: Array<{ text: string; options: unknown }> = [];
  const activeTools: string[][] = [];
  const api: PiExtensionApi = {
    registerTool<TParams>(tool: PiToolDefinition<TParams>) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    async sendUserMessage(text, options) {
      messages.push({ text, options });
    },
    setActiveTools(names) {
      activeTools.push([...names]);
    },
  };
  return {
    api,
    getTool<TParams>(name: string) {
      return tools.get(name) as PiToolDefinition<TParams> | undefined;
    },
    handlers,
    messages,
    activeTools,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for condition");
}

test("idle Worker receives durable startup and wake-driven steering as Pi user messages", async () => {
  const { paths, store, taskId, workerId } = await fixture();
  process.env.SWITCHYARD_TASK_ID = taskId;
  process.env.SWITCHYARD_WORKER_ID = workerId;
  enqueueMessage(store, taskId, "worker", "Original Task instruction");
  const fake = fakePi();
  workerExtension(fake.api);

  await fake.handlers.get("session_start")?.();
  assert.equal(fake.messages.length, 1);
  const initialMessage = fake.messages[0];
  assert.ok(initialMessage);
  assert.match(initialMessage.text, /Original Task instruction/);
  assert.deepEqual(initialMessage.options, { deliverAs: "steer" });
  const enabledTools = fake.activeTools.at(-1);
  assert.ok(enabledTools);
  assert.ok(enabledTools.includes("bash"));

  enqueueMessage(store, taskId, "worker", "Steer the idle Worker");
  await signalWake(paths.wake, `worker-${workerId}.wake`);
  await waitFor(() => fake.messages.length === 2);
  const steeringMessage = fake.messages[1];
  assert.ok(steeringMessage);
  assert.match(steeringMessage.text, /Steer the idle Worker/);
  assert.equal(store.listPendingMessages(taskId, "worker").length, 0);

  await fake.handlers.get("session_shutdown")?.();
  store.close();
});

test("Reviewer receives an initial review request as a Pi user message", async () => {
  process.env.SWITCHYARD_REVIEW_ID = "review-1";
  const fake = fakePi();
  reviewerExtension(fake.api);

  await fake.handlers.get("session_start")?.();

  assert.deepEqual(fake.activeTools.at(-1), ["read", "switchyard_submit_review"]);
  const initialMessage = fake.messages[0];
  assert.ok(initialMessage);
  assert.match(initialMessage.text, /Begin the independent review/);
  assert.deepEqual(initialMessage.options, { deliverAs: "steer" });
});

test("Supervisor steering resumes a waiting Task through the shared domain operation", async () => {
  const { store, taskId } = await fixture("waiting");
  const fake = fakePi();
  supervisorExtension(fake.api);
  const tool = fake.getTool<{ task: string; text: string }>("switchyard_send_message");
  assert.ok(tool);

  await tool.execute("call", {
    task: "sample durable instruction",
    text: "Resume with this guidance",
  });

  assert.equal(store.getTask(taskId)?.state, "running");
  assert.match(
    store.listPendingMessages(taskId, "worker")[0]?.text ?? "",
    /Resume with this guidance/,
  );
  store.close();
});

test("Supervisor contract uses natural Task references and omits internal record IDs", async () => {
  const { store, taskId } = await fixture("waiting");
  const fake = fakePi();
  supervisorExtension(fake.api);

  const delegateTool = fake.getTool<{ project: string; instruction: string }>(
    "switchyard_delegate",
  );
  const listTool = fake.getTool<Record<string, never>>("switchyard_list_tasks");
  const getTool = fake.getTool<{ task: string }>("switchyard_get_task");
  const sendTool = fake.getTool<{ task: string; text: string }>("switchyard_send_message");
  const resolveTool = fake.getTool<{ task: string; answer: string }>("switchyard_resolve_decision");
  const cancelTool = fake.getTool<{ task: string }>("switchyard_cancel_task");
  assert.ok(delegateTool && listTool && getTool && sendTool && resolveTool && cancelTool);
  const schemas = [
    delegateTool.parameters,
    listTool.parameters,
    getTool.parameters,
    sendTool.parameters,
    resolveTool.parameters,
    cancelTool.parameters,
  ];
  assert.doesNotMatch(JSON.stringify(schemas), /task_id|decision_id/);
  store.db.prepare("UPDATE tasks SET failure=? WHERE id=?").run(taskId, taskId);

  const listed = (await listTool.execute("call", {})) as { details: unknown };
  const found = (await getTool.execute("call", { task: "sample durable instruction" })) as {
    details: { project: string; task: string; state: string; failure: string };
  };
  assert.equal(found.details.project, "sample");
  assert.match(found.details.task, /durable instruction/);
  assert.equal(found.details.state, "waiting");
  assert.equal(found.details.failure, "an internal identifier");
  for (const value of [listed.details, found.details]) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(
      serialized,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    assert.doesNotMatch(serialized, /task_id|decision_id/);
  }

  const { requestDecision } = await import("../src/tasks.ts");
  store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(taskId);
  const decisionId = requestDecision(store, taskId, "Which value?", undefined, ["alpha", "beta"]);
  await resolveTool.execute("call", { task: "sample durable instruction", answer: "alpha" });
  assert.equal(store.getDecision(decisionId)?.state, "resolved");
  assert.equal(store.getTask(taskId)?.state, "running");
  store.close();
});

test("unknown projects enter intake and remote implementation requires a registered Project", async () => {
  const { store } = await fixture();
  const fake = fakePi();
  supervisorExtension(fake.api);
  const delegate = fake.getTool<{
    project: string;
    kind: "implement" | "investigate";
    instruction: string;
    review?: boolean;
    remote_action?: "clone" | "review_only";
  }>("switchyard_delegate");
  assert.ok(delegate);
  assert.equal(
    ((delegate.parameters as { required?: string[] }).required ?? []).includes("review"),
    false,
  );

  const unknown = (await delegate.execute("call", {
    project: "unknown-project",
    kind: "investigate",
    instruction: "Inspect it",
    review: false,
  })) as { details: { status: string; required: string[] } };
  assert.equal(unknown.details.status, "project_intake_required");
  assert.deepEqual(unknown.details.required, ["project_name", "project_location"]);
  const cloneChoice = (await delegate.execute("call", {
    project: "https://example.invalid/repo.git",
    kind: "investigate",
    instruction: "Inspect the remote",
    review: false,
  })) as { details: { status: string; choices: string[] } };
  assert.equal(cloneChoice.details.status, "project_intake_required");
  assert.deepEqual(cloneChoice.details.choices, ["clone", "review_only"]);
  const cloneNeedsDetails = (await delegate.execute("call", {
    project: "https://example.invalid/repo.git",
    kind: "investigate",
    instruction: "Clone only after intake",
    review: false,
    remote_action: "clone",
  })) as { details: { status: string; action: string; required: string[] } };
  assert.equal(cloneNeedsDetails.details.status, "project_intake_required");
  assert.equal(cloneNeedsDetails.details.action, "clone");
  assert.deepEqual(cloneNeedsDetails.details.required, ["project_name", "project_location"]);
  const remote = (await delegate.execute("call", {
    project: "https://example.invalid/repo.git",
    kind: "implement",
    instruction: "Implement the remote change",
    review: false,
    remote_action: "review_only",
  })) as { details: { status: string; message: string; required_for_clone: string[] } };
  assert.equal(remote.details.status, "project_intake_required");
  assert.match(remote.details.message, /Implementation requires a registered Project/);
  assert.deepEqual(remote.details.required_for_clone, ["project_name", "project_location"]);
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.listTasks().length, 1);
  store.close();
});

test("review-only remote investigation uses a transient checkout without Project registration", async () => {
  const { paths, store } = await fixture();
  const root = path.dirname(paths.home);
  const remote = path.join(root, "remote");
  const bin = path.join(root, "bin");
  const tmuxState = path.join(root, "fake-tmux-state");
  await mkdir(remote);
  await mkdir(bin);
  await exec("git", ["init", "-b", "main"], { cwd: remote });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: remote });
  await exec("git", ["config", "user.name", "SwitchYard Test"], { cwd: remote });
  await writeFile(path.join(remote, "README.md"), "remote source\n");
  await exec("git", ["add", "."], { cwd: remote });
  await exec("git", ["commit", "-m", "remote base"], { cwd: remote });
  const { stdout: gitPath } = await exec("which", ["git"]);
  const remoteUrl = "https://example.invalid/repo.git";
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env bash\nif [[ "$1" == clone && "$3" == ${JSON.stringify(remoteUrl)} ]]; then\n  exec ${JSON.stringify(gitPath.trim())} clone -- ${JSON.stringify(remote)} "$4"\nfi\nexec ${JSON.stringify(gitPath.trim())} "$@"\n`,
  );
  await writeFile(
    path.join(bin, "tmux"),
    `#!/usr/bin/env bash\nset -e\nstate=${JSON.stringify(tmuxState)}\ncase "$1" in\n  has-session) [[ -f "$state" ]] ;;\n  new-session|new-window) printf '%s\\n' "$6" >> "$state" ;;\n  list-windows) i=0; while IFS= read -r name; do i=$((i+1)); printf '@%s\\t%s\\n' "$i" "$name"; done < "$state" ;;\n  display-message) echo 0 ;;\n  *) : ;;\nesac\n`,
  );
  await chmod(path.join(bin, "git"), 0o755);
  await chmod(path.join(bin, "tmux"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.SWITCHYARD_HOME = paths.home;
  const fake = fakePi();
  supervisorExtension(fake.api);
  const delegate = fake.getTool<{
    project: string;
    kind: "implement" | "investigate";
    instruction: string;
    remote_action: "review_only";
  }>("switchyard_delegate");
  assert.ok(delegate);

  const response = (await delegate.execute("call", {
    project: remoteUrl,
    kind: "investigate",
    instruction: "Inspect the remote source",
    remote_action: "review_only",
  })) as { details: { status: string; registered: boolean; task_started: boolean } };

  assert.equal(response.details.status, "task_started");
  assert.equal(response.details.registered, false);
  assert.equal(response.details.task_started, true);
  assert.equal(store.listProjects().length, 1);
  const task = store.listTasks().find((record) => record.source_url === remoteUrl);
  assert.ok(task);
  assert.equal(task.project_id, null);
  assert.equal(task.review_policy, "off");
  assert.equal(task.state, "running");
  assert.ok(task.source_path && existsSync(task.source_path));
  assert.ok(store.getWorkspace(task.id)?.provisioned);
  store.close();
});

test("Supervisor and Reviewer authority is mechanically allowlisted", async () => {
  const supervisor = fakePi();
  supervisorExtension(supervisor.api);
  // The allowlist is applied on session_start; use an empty durable home.
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-role-"));
  dirs.push(root);
  process.env.SWITCHYARD_HOME = path.join(root, "home");
  await supervisor.handlers.get("session_start")?.();
  const active = supervisor.activeTools.at(-1);
  assert.ok(active);
  assert.deepEqual(
    active.sort(),
    [
      "switchyard_cancel_task",
      "switchyard_delegate",
      "switchyard_get_task",
      "switchyard_list_tasks",
      "switchyard_resolve_decision",
      "switchyard_send_message",
    ].sort(),
  );
  assert.equal(active.includes("bash"), false);
  assert.equal(active.includes("edit"), false);
  await supervisor.handlers.get("session_shutdown")?.();
});
