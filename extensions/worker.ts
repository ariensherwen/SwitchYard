import { openSwitchYard } from "../src/context.ts";
import { markDelivered, startWakePump } from "../src/inbox.ts";
import { beginReview } from "../src/review.ts";
import { retireWorker, startReviewer, wakeSupervisor } from "../src/runtime.ts";
import type { StateStore, TaskState } from "../src/state.ts";
import { markWaiting, requestDecision, submitCandidate } from "../src/tasks.ts";
import type { PiExtensionApi } from "./pi-types.ts";
import { objectSchema, stringArraySchema, stringSchema } from "./schema.ts";

interface CompleteParams {
  summary: string;
  verification_summary: string;
}

interface DecisionParams {
  question: string;
  context?: string;
  options?: string[];
}

interface WaitParams {
  reason: string;
}

const WORKER_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "switchyard_complete",
  "switchyard_request_decision",
  "switchyard_wait",
];

export default function workerExtension(pi: PiExtensionApi) {
  const taskId = requiredEnv("SWITCHYARD_TASK_ID");
  const workerId = requiredEnv("SWITCHYARD_WORKER_ID");
  let stopWakePump: (() => void) | undefined;
  let delivering = false;
  const awaitingConsumption = new Set<string>();

  const result = (value: unknown) => ({
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    details: value,
  });

  pi.registerTool({
    name: "switchyard_complete",
    label: "Submit candidate",
    description: "Submit the current committed task result to SwitchYard's completion policy.",
    parameters: objectSchema({ summary: stringSchema(), verification_summary: stringSchema() }, [
      "summary",
      "verification_summary",
    ]),
    async execute(_id: string, params: CompleteParams, _signal, _onUpdate, ctx) {
      const { paths, store } = await openSwitchYard();
      try {
        assertActiveWorker(store);
        const submitted = await submitCandidate(
          store,
          taskId,
          params.summary,
          params.verification_summary,
        );
        if (submitted.task.state === "reviewing") {
          setToolsForState(pi, "reviewing");
          const reviewId = await beginReview(store, paths, taskId);
          await startReviewer(store, paths, reviewId);
          await wakeSupervisor(paths);
          return result({
            state: "reviewing",
            candidate_sha: submitted.candidateSha,
            review_id: reviewId,
          });
        }
        retireWorker(store, taskId, workerId, "task reached terminal completion");
        pi.setActiveTools([]);
        await wakeSupervisor(paths);
        ctx?.shutdown();
        return result(submitted.task);
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_request_decision",
    label: "Request decision",
    description: "Pause this Task on a durable human/Supervisor Decision.",
    parameters: objectSchema(
      { question: stringSchema(), context: stringSchema(), options: stringArraySchema() },
      ["question"],
    ),
    async execute(_id: string, params: DecisionParams) {
      const { paths, store } = await openSwitchYard();
      try {
        assertActiveWorker(store);
        const decisionId = requestDecision(
          store,
          taskId,
          params.question,
          params.context,
          params.options,
        );
        setToolsForState(pi, "needs_decision");
        await wakeSupervisor(paths);
        return result({ decision_id: decisionId });
      } finally {
        store.close();
      }
    },
  });

  pi.registerTool({
    name: "switchyard_wait",
    label: "Wait",
    description:
      "Explicitly mark this Task waiting for external input or a later steering message.",
    parameters: objectSchema({ reason: stringSchema() }, ["reason"]),
    async execute(_id: string, params: WaitParams) {
      const { paths, store } = await openSwitchYard();
      try {
        assertActiveWorker(store);
        const task = markWaiting(store, taskId, params.reason);
        setToolsForState(pi, task.state);
        await wakeSupervisor(paths);
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  async function deliverPending() {
    if (delivering) return;
    delivering = true;
    try {
      const { store } = await openSwitchYard();
      try {
        if (store.getActiveWorker(taskId)?.id !== workerId) {
          pi.setActiveTools([]);
          return;
        }
        const task = store.getTask(taskId);
        if (!task) return;
        setToolsForState(pi, task.state);
        if (task.state !== "running") return;
        const messages = store
          .listPendingMessages(taskId, "worker")
          .filter((message) => !awaitingConsumption.has(message.id));
        if (messages.length === 0) return;
        for (const message of messages) awaitingConsumption.add(message.id);
        const payload = messages.map((message) => message.text).join("\n\n---\n\n");
        try {
          await pi.sendUserMessage(payload, { deliverAs: "steer" });
        } catch (error) {
          for (const message of messages) awaitingConsumption.delete(message.id);
          throw error;
        }
      } finally {
        store.close();
      }
    } finally {
      delivering = false;
    }
  }

  pi.on("tool_call", async (event) => {
    const toolName = (event as { toolName?: string } | undefined)?.toolName;
    if (!toolName || !["read", "bash", "edit", "write"].includes(toolName)) return undefined;
    const { store } = await openSwitchYard();
    try {
      const task = store.getTask(taskId);
      if (task?.state === "running" && store.getActiveWorker(taskId)?.id === workerId)
        return undefined;
      return {
        block: true,
        reason: `Task ${taskId} is not running; Worker mutation authority is suspended.`,
      };
    } finally {
      store.close();
    }
  });

  pi.on("session_start", async () => {
    const { paths, store } = await openSwitchYard();
    try {
      const task = store.getTask(taskId);
      setToolsForState(pi, task?.state ?? "failed");
      store.event(taskId, "worker.session_started", { worker_id: workerId });
      stopWakePump ??= startWakePump(paths.wake, `worker-${workerId}.wake`, deliverPending);
    } finally {
      store.close();
    }
    await deliverPending();
  });
  pi.on("turn_start", async () => {
    await record("worker.turn_started");
  });
  pi.on("turn_end", async () => {
    await record("worker.turn_finished");
  });
  pi.on("agent_end", async () => {
    await record("worker.settled");
    await deliverPending();
  });
  // Pi can resolve sendUserMessage when it only queues steering; agent_settled confirms queued work finished.
  pi.on("agent_settled", async () => {
    const messageIds = [...awaitingConsumption];
    if (messageIds.length === 0) return;
    try {
      const { store } = await openSwitchYard();
      try {
        store.transaction(() => {
          for (const messageId of messageIds) markDelivered(store, messageId);
        });
      } finally {
        store.close();
      }
      for (const messageId of messageIds) awaitingConsumption.delete(messageId);
    } catch (error) {
      for (const messageId of messageIds) awaitingConsumption.delete(messageId);
      throw error;
    }
  });
  pi.on("session_shutdown", async () => {
    stopWakePump?.();
    stopWakePump = undefined;
    await record("worker.session_shutdown");
  });

  async function record(type: string) {
    const { store } = await openSwitchYard();
    try {
      store.event(taskId, type, { worker_id: workerId });
    } finally {
      store.close();
    }
  }

  function assertActiveWorker(store: StateStore) {
    if (store.getActiveWorker(taskId)?.id !== workerId) {
      throw new Error("this Pi session is not the active Worker for the Task");
    }
  }
}

function setToolsForState(pi: PiExtensionApi, state: TaskState): void {
  pi.setActiveTools(state === "running" ? WORKER_TOOLS : []);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
