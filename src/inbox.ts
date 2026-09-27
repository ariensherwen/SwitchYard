import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
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

export function startWakePump(
  wakeDir: string,
  target: string,
  callback: () => void | Promise<void>,
  intervalMs = 1000,
): () => void {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(wakeDir, (_event, filename) => {
      if (filename === target) void callback();
    });
  } catch {
    // Polling below is the durability fallback when fs.watch is unavailable.
  }
  const timer = setInterval(() => void callback(), intervalMs);
  timer.unref();
  return () => {
    watcher?.close();
    clearInterval(timer);
  };
}
