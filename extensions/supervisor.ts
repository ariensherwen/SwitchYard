import { openSwitchYard } from "../src/context.ts";
import { markDelivered, startWakePump } from "../src/inbox.ts";
import { addProject } from "../src/projects.ts";
import { reconcile } from "../src/reconcile.ts";
import { quiesceTaskRuntimes, startWorker, wakeWorker } from "../src/runtime.ts";
import type { MessageRecord, TaskKind } from "../src/state.ts";
import {
  cancelTask,
  createTask,
  failTask,
  resolveDecision,
  startTask,
  steerTask,
} from "../src/tasks.ts";
import type { PiExtensionApi } from "./pi-types.ts";
import { booleanSchema, enumSchema, objectSchema, stringSchema } from "./schema.ts";

interface DelegateParams {
  project: string;
  kind: TaskKind;
  instruction: string;
  review: boolean;
}

interface TaskParams {
  task_id: string;
}

interface SendMessageParams extends TaskParams {
  text: string;
}

interface ResolveDecisionParams extends TaskParams {
  decision_id: string;
  answer: string;
}

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
  const result = (value: unknown) => ({
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    details: value,
  });

  pi.registerTool({
    name: "switchyard_delegate",
    label: "Delegate task",
    description: "Create and start a durable SwitchYard task in a registered project.",
    parameters: objectSchema(
      {
        project: stringSchema(),
        kind: enumSchema(["implement", "investigate"]),
        instruction: stringSchema(),
        review: booleanSchema(),
      },
      ["project", "kind", "instruction", "review"],
    ),
    async execute(_id: string, params: DelegateParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const project =
          store.getProject(params.project) ?? (await addProject(store, paths, params.project));
        const task = createTask(
          store,
          project.id,
          params.kind,
          params.instruction,
          params.review ? "loop" : "off",
        );
        try {
          await startTask(store, paths, task.id);
          await startWorker(store, paths, task.id);
        } catch (error) {
          const current = store.getTask(task.id);
          if (current?.state === "starting") {
            failTask(
              store,
              task.id,
              `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            await quiesceTaskRuntimes(store, task.id);
          }
        }
        return result(store.getTask(task.id));
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_list_tasks",
    label: "List tasks",
    description: "List durable SwitchYard tasks.",
    parameters: objectSchema({}),
    async execute() {
      const { store } = await openSwitchYard();
      try {
        return result(store.listTasks());
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_get_task",
    label: "Get task",
    description: "Inspect one durable SwitchYard task.",
    parameters: objectSchema({ task_id: stringSchema() }, ["task_id"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const task = store.getTask(params.task_id);
        if (!task) throw new Error("task not found");
        return result({
          task,
          workspace: store.getWorkspace(task.id),
          decision: store.getOpenDecision(task.id),
          review: store.getLatestReview(task.id),
          events: store.listEvents(task.id),
        });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_send_message",
    label: "Steer task",
    description: "Persist steering for a nonterminal task and resume it when explicitly waiting.",
    parameters: objectSchema({ task_id: stringSchema(), text: stringSchema() }, [
      "task_id",
      "text",
    ]),
    async execute(_id: string, params: SendMessageParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const task = steerTask(store, params.task_id, params.text);
        await wakeWorker(store, paths, task.id);
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_resolve_decision",
    label: "Resolve decision",
    description: "Atomically resolve an open Decision and resume its Task.",
    parameters: objectSchema(
      { task_id: stringSchema(), decision_id: stringSchema(), answer: stringSchema() },
      ["task_id", "decision_id", "answer"],
    ),
    async execute(_id: string, params: ResolveDecisionParams) {
      const { paths, store } = await openSwitchYard();
      try {
        const task = resolveDecision(store, params.task_id, params.decision_id, params.answer);
        await wakeWorker(store, paths, task.id);
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_cancel_task",
    label: "Cancel task",
    description: "Cancel a nonterminal Task while preserving its Workspace.",
    parameters: objectSchema({ task_id: stringSchema() }, ["task_id"]),
    async execute(_id: string, params: TaskParams) {
      const { store } = await openSwitchYard();
      try {
        const task = cancelTask(store, params.task_id);
        await quiesceTaskRuntimes(store, task.id);
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  async function deliverSupervisorMessages() {
    if (delivering) return;
    delivering = true;
    try {
      const { paths, store } = await openSwitchYard();
      try {
        pi.setActiveTools(SUPERVISOR_TOOLS);
        await reconcile(store, paths);
        const rows = store.db
          .prepare(
            "SELECT * FROM messages WHERE recipient='supervisor' AND state='pending' ORDER BY created_at, id",
          )
          .all() as unknown as MessageRecord[];
        if (rows.length === 0) return;
        await pi.sendUserMessage(rows.map((row) => row.text).join("\n\n---\n\n"), {
          deliverAs: "steer",
        });
        store.transaction(() => {
          for (const message of rows) markDelivered(store, message.id);
        });
      } finally {
        store.close();
      }
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
  pi.on("agent_end", deliverSupervisorMessages);
  pi.on("session_shutdown", async () => {
    stopWakePump?.();
    stopWakePump = undefined;
  });
}
