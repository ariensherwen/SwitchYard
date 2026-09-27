import { openSwitchYard } from "../src/context.ts";
import { submitReview, type ReviewSubmission } from "../src/review.ts";
import { quiesceTaskRuntimes, replaceWorker, wakeSupervisor, wakeWorker } from "../src/runtime.ts";
import type { PiExtensionApi } from "./pi-types.ts";
import { enumSchema, objectSchema, stringArraySchema, stringSchema } from "./schema.ts";

const findingSchema = objectSchema(
  {
    summary: stringSchema(),
    rationale: stringSchema(),
    required_change: stringSchema(),
    path: stringSchema(),
    line: { type: "number" },
  },
  ["summary", "rationale", "required_change"],
);

const REVIEWER_TOOLS = ["read", "switchyard_submit_review"];

export default function reviewerExtension(pi: PiExtensionApi) {
  const reviewId = requiredEnv("SWITCHYARD_REVIEW_ID");
  pi.registerTool({
    name: "switchyard_submit_review",
    label: "Submit review",
    description: "Submit the independent review for this exact candidate revision.",
    parameters: objectSchema(
      {
        verdict: enumSchema(["clean", "changes_requested"]),
        summary: stringSchema(),
        reviewed_paths: stringArraySchema(),
        findings: { type: "array", items: findingSchema },
      },
      ["verdict", "summary", "reviewed_paths", "findings"],
    ),
    async execute(_id: string, params: ReviewSubmission, _signal, _onUpdate, ctx) {
      const { paths, store } = await openSwitchYard();
      try {
        const review = store.getReview(reviewId);
        if (!review) throw new Error("review not found");
        await submitReview(store, reviewId, params);
        if (params.verdict === "changes_requested") {
          await replaceWorker(store, paths, review.task_id);
          await wakeWorker(store, paths, review.task_id);
        } else {
          await quiesceTaskRuntimes(store, review.task_id, { keepReviewId: reviewId });
        }
        pi.setActiveTools([]);
        await wakeSupervisor(paths);
        ctx?.shutdown();
        return {
          content: [{ type: "text", text: `Review ${reviewId} accepted as ${params.verdict}` }],
          details: { review_id: reviewId, verdict: params.verdict },
        };
      } finally {
        store.close();
      }
    },
  });

  pi.on("tool_call", async (event) => {
    const toolName = (event as { toolName?: string } | undefined)?.toolName;
    if (!toolName || REVIEWER_TOOLS.includes(toolName)) return undefined;
    return { block: true, reason: "Reviewer is read-only and may only submit the review result." };
  });

  pi.on("session_start", async () => {
    pi.setActiveTools(REVIEWER_TOOLS);
  });
  pi.on("session_shutdown", async () => {
    pi.setActiveTools([]);
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
