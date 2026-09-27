import { openSwitchYard } from "../src/context.ts";
import { markDelivered } from "../src/inbox.ts";
import { beginReview } from "../src/review.ts";
import { startReviewer, wakeSupervisor } from "../src/runtime.ts";
import type { StateStore } from "../src/state.ts";
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

export default function workerExtension(pi: PiExtensionApi) {
  const taskId = requiredEnv("SWITCHYARD_TASK_ID");
  const workerId = requiredEnv("SWITCHYARD_WORKER_ID");
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
    async execute(_id: string, params: CompleteParams) {
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
          const reviewId = await beginReview(store, paths, taskId);
          await startReviewer(store, paths, reviewId);
          await wakeSupervisor();
          return result({
            state: "reviewing",
            candidate_sha: submitted.candidateSha,
            review_id: reviewId,
          });
        }
        await wakeSupervisor();
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
      const { store } = await openSwitchYard();
      try {
        assertActiveWorker(store);
        const decisionId = requestDecision(
          store,
          taskId,
          params.question,
          params.context,
          params.options,
        );
        await wakeSupervisor();
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
      const { store } = await openSwitchYard();
      try {
        assertActiveWorker(store);
        const task = markWaiting(store, taskId, params.reason);
        await wakeSupervisor();
        return result(task);
      } finally {
        store.close();
      }
    },
  });

  async function deliverPending() {
    const { store } = await openSwitchYard();
    try {
      if (store.getActiveWorker(taskId)?.id !== workerId) return;
      for (const message of store.listPendingMessages(taskId, "worker")) {
        await pi.sendUserMessage(message.text, { deliverAs: "followUp" });
        markDelivered(store, message.id);
      }
    } finally {
      store.close();
    }
  }

  pi.on("session_start", async () => {
    await record("worker.session_started");
    await deliverPending();
  });
  pi.on("turn_start", async () => {
    await record("worker.turn_started");
    await deliverPending();
  });
  pi.on("turn_end", async () => {
    await record("worker.turn_finished");
  });
  pi.on("agent_settled", async () => {
    await record("worker.settled");
    await deliverPending();
  });
  pi.on("session_shutdown", async () => {
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
