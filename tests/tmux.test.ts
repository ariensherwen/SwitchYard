import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const session = `switchyard-test-${process.pid}`;
process.env.SWITCHYARD_TMUX_SESSION = session;
const { attachWindow, killWindow, resolveTmuxSession, showWindowReadOnly, windowAlive } =
  await import("../src/tmux.ts");
const hasTmux = await exec("tmux", ["-V"]).then(
  () => true,
  () => false,
);

after(async () => {
  if (hasTmux) await exec("tmux", ["kill-session", "-t", session]).catch(() => undefined);
});

test("default tmux sessions are isolated by SwitchYard home", () => {
  const first = resolveTmuxSession({ SWITCHYARD_HOME: "/tmp/switchyard-one" });
  const second = resolveTmuxSession({ SWITCHYARD_HOME: "/tmp/switchyard-two" });
  assert.notEqual(first, second);
  assert.equal(
    resolveTmuxSession({ SWITCHYARD_HOME: "/tmp/switchyard-one/..//switchyard-one" }),
    first,
  );
  assert.equal(resolveTmuxSession({ SWITCHYARD_TMUX_SESSION: "explicit" }), "explicit");
});

test("Worker observation uses a live read-only tmux popup instead of switching panes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchyard-tmux-readonly-"));
  const previousPath = process.env.PATH;
  const tmuxLog = path.join(root, "commands");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeTmux = path.join(bin, "tmux");
  await writeFile(
    fakeTmux,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TMUX_COMMAND_LOG"\nif [ "$1" = list-windows ]; then printf '@7\\tworker-t1\\n'; fi\n`,
  );
  await chmod(fakeTmux, 0o755);
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.TMUX_COMMAND_LOG = tmuxLog;
  try {
    await showWindowReadOnly("worker-t1");
    const commands = await readFile(tmuxLog, "utf8");
    assert.match(commands, /display-popup/);
    assert.match(commands, /capture-pane/);
    assert.match(commands, /key\.includes\(113\)/);
    assert.match(commands, /process\.exit\(0\)/);
    assert.doesNotMatch(commands, /attach-session|switch-client|send-keys/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.TMUX_COMMAND_LOG;
    await rm(root, { recursive: true, force: true });
  }
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
