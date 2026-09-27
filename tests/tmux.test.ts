import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const session = `switchyard-test-${process.pid}`;
const hasTmux = await exec("tmux", ["-V"]).then(
  () => true,
  () => false,
);

after(async () => {
  if (hasTmux) await exec("tmux", ["kill-session", "-t", session]).catch(() => undefined);
});

test("real tmux session/window liveness", { skip: !hasTmux }, async () => {
  await exec("tmux", ["new-session", "-d", "-s", session, "-n", "supervisor"]);
  await exec("tmux", ["new-window", "-d", "-t", session, "-n", "task-t1", "sleep", "10"]);
  const { stdout } = await exec("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"]);
  assert.match(stdout, /supervisor/);
  assert.match(stdout, /task-t1/);
});
