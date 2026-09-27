import { openSwitchYard } from "../src/context.ts";
import { reconcile } from "../src/reconcile.ts";
import { type ReviewSubmission, submitReview } from "../src/review.ts";
import { wakeSupervisor, wakeWorker } from "../src/runtime.ts";
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
    async execute(_id: string, params: ReviewSubmission) {
      const { paths, store } = await openSwitchYard();
      try {
        const review = store.getReview(reviewId);
        if (!review) throw new Error("review not found");
        await submitReview(store, reviewId, params);
        if (params.verdict === "changes_requested") {
          await reconcile(store, paths);
          await wakeWorker(store, review.task_id);
        }
        await wakeSupervisor();
        return {
          content: [{ type: "text", text: `Review ${reviewId} accepted as ${params.verdict}` }],
          details: { review_id: reviewId, verdict: params.verdict },
        };
      } finally {
        store.close();
      }
    },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
