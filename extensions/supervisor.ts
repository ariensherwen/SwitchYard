import { openSwitchYard } from "../src/context.ts";
import { enqueueMessage, markDelivered } from "../src/inbox.ts";
import { addProject } from "../src/projects.ts";
import { reconcile } from "../src/reconcile.ts";
import { startWorker, stopWorker, wakeWorker } from "../src/runtime.ts";
import type { MessageRecord, TaskKind } from "../src/state.ts";
import { cancelTask, createTask, failTask, resolveDecision, startTask } from "../src/tasks.ts";
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

export default function supervisorExtension(pi: PiExtensionApi) {
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
    description: "Persist a steering message for a nonterminal task and wake its Worker.",
    parameters: objectSchema({ task_id: stringSchema(), text: stringSchema() }, ["task_id", "text"]),
    async execute(_id: string, params: SendMessageParams) {
      const { store } = await openSwitchYard();
      try {
        const task = store.getTask(params.task_id);
        if (!task || ["completed", "failed", "cancelled"].includes(task.state)) {
          throw new Error("task is missing or terminal");
        }
        const messageId = enqueueMessage(store, task.id, "worker", params.text);
        await wakeWorker(store, task.id);
        return result({ message_id: messageId });
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
      const { store } = await openSwitchYard();
      try {
        const task = resolveDecision(store, params.task_id, params.decision_id, params.answer);
        await wakeWorker(store, task.id);
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
        await stopWorker(store, task.id);
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  async function deliverSupervisorMessages() {
    const { paths, store } = await openSwitchYard();
    try {
      await reconcile(store, paths);
      const rows = store.db
        .prepare(
          "SELECT * FROM messages WHERE recipient='supervisor' AND state='pending' ORDER BY created_at, id",
        )
        .all() as unknown as MessageRecord[];
      for (const message of rows) {
        await pi.sendUserMessage(message.text, { deliverAs: "followUp" });
        markDelivered(store, message.id);
      }
    } finally {
      store.close();
    }
  }

  pi.on("session_start", deliverSupervisorMessages);
  pi.on("agent_end", deliverSupervisorMessages);
}
