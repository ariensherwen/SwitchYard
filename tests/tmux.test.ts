import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const session = `switchyard-test-${process.pid}`;
process.env.SWITCHYARD_TMUX_SESSION = session;
const { attachWindow, killWindow, windowAlive } = await import("../src/tmux.ts");
const hasTmux = await exec("tmux", ["-V"]).then(
  () => true,
  () => false,
);

after(async () => {
  if (hasTmux) await exec("tmux", ["kill-session", "-t", session]).catch(() => undefined);
});

test("real tmux session/window liveness", { skip: !hasTmux }, async () => {
  await exec("tmux", ["new-session", "-d", "-s", session, "-n", "supervisor", "sleep", "10"]);
  await exec("tmux", ["new-window", "-d", "-t", session, "-n", "task-t1", "sleep", "10"]);
  assert.equal(await windowAlive("task-t1"), true);
  assert.equal(await windowAlive("missing-window"), false);
  await killWindow("missing-window");
  const { stdout } = await exec("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"]);
  assert.deepEqual(stdout.trim().split(/\r?\n/).sort(), ["supervisor", "task-t1"]);

  const { stdout: tmuxContext } = await exec("tmux", [
    "display-message",
    "-p",
    "-t",
    `${session}:supervisor`,
    "#{socket_path},#{pid},#{session_id}",
  ]);
  const { stdout: supervisorPane } = await exec("tmux", [
    "display-message",
    "-p",
    "-t",
    `${session}:supervisor`,
    "#{pane_id}",
  ]);
  const previousTmux = process.env.TMUX;
  const previousPane = process.env.TMUX_PANE;
  try {
    process.env.TMUX = tmuxContext.trim();
    process.env.TMUX_PANE = supervisorPane.trim();
    assert.equal(await attachWindow("task-t1"), 0);
    const { stdout: selected } = await exec("tmux", [
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_name} #{window_active}",
    ]);
    assert.deepEqual(
      selected
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.endsWith(" 1")),
      ["task-t1 1"],
    );
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousPane;
  }
});
