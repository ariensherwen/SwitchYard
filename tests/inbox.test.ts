import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { startWakePump } from "../src/inbox.ts";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

test("wake pump retries after a callback rejects", async () => {
  const wakeDir = await mkdtemp(path.join(os.tmpdir(), "switchyard-wake-pump-"));
  dirs.push(wakeDir);
  let attempts = 0;
  let resolveSucceeded!: () => void;
  const succeeded = new Promise<void>((resolve) => {
    resolveSucceeded = resolve;
  });
  let timeout: NodeJS.Timeout | undefined;
  const stop = startWakePump(
    wakeDir,
    "worker.wake",
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient delivery failure");
      resolveSucceeded();
    },
    10,
  );

  try {
    await Promise.race([
      succeeded,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("wake pump did not retry")), 1000);
      }),
    ]);
    assert.ok(attempts >= 2);
  } finally {
    stop();
    if (timeout) clearTimeout(timeout);
  }
});
