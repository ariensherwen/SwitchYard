import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const extension = (name: string) => readFile(path.resolve("extensions", `${name}.ts`), "utf8");

test("Supervisor exposes only supervisor control tools", async () => {
  const text = await extension("supervisor");
  for (const name of [
    "switchyard_delegate",
    "switchyard_list_tasks",
    "switchyard_get_task",
    "switchyard_send_message",
    "switchyard_resolve_decision",
    "switchyard_cancel_task",
  ])
    assert.match(text, new RegExp(name));
  assert.doesNotMatch(text, /switchyard_complete/);
  assert.doesNotMatch(text, /switchyard_submit_review/);
});

test("Worker has no supervisor or review acceptance authority", async () => {
  const text = await extension("worker");
  for (const name of ["switchyard_complete", "switchyard_request_decision", "switchyard_wait"])
    assert.match(text, new RegExp(name));
  assert.doesNotMatch(text, /switchyard_cancel_task/);
  assert.doesNotMatch(text, /switchyard_submit_review/);
});

test("Reviewer exposes review submission only", async () => {
  const text = await extension("reviewer");
  assert.match(text, /switchyard_submit_review/);
  assert.doesNotMatch(text, /switchyard_complete/);
  assert.doesNotMatch(text, /switchyard_cancel_task/);
});
