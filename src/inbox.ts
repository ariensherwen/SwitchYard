import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { StateStore } from "./state.ts";
import { now } from "./state.ts";

export function enqueueMessage(
  store: StateStore,
  taskId: string,
  recipient: "worker" | "supervisor",
  text: string,
): string {
  const id = randomUUID();
  return store.transaction(() => {
    store.db
      .prepare(
        "INSERT INTO messages(id, task_id, recipient, text, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      )
      .run(id, taskId, recipient, text, now());
    store.event(taskId, "message.queued", { id, recipient });
    return id;
  });
}

export function markDelivered(store: StateStore, messageId: string): void {
  store.db
    .prepare("UPDATE messages SET state='delivered', delivered_at=? WHERE id=? AND state='pending'")
    .run(now(), messageId);
}

export async function signalWake(wakeDir: string, target: string): Promise<void> {
  await writeFile(path.join(wakeDir, target), `${Date.now()}\n`, "utf8");
}
