import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSwitchYardHome } from "./home.ts";

const execFileAsync = promisify(execFile);
export function tmuxSessionForHome(home: string): string {
  const canonicalHome = resolveSwitchYardHome({ SWITCHYARD_HOME: home });
  const leaf = tmuxLabel(path.basename(canonicalHome));
  const parent = tmuxLabel(path.basename(path.dirname(canonicalHome)));
  const context = leaf === "switchyard" ? parent : [parent, leaf].filter(Boolean).join("-");
  const suffix = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 6);
  return `switchyard-${context || "default"}-${suffix}`;
}

export function taskWindowName(
  role: "worker" | "review",
  projectName: string,
  taskTitle: string,
  id: string,
): string {
  const project = tmuxLabel(projectName).slice(0, 24);
  const task = tmuxLabel(taskTitle).slice(0, 40);
  const suffix = tmuxLabel(id).slice(0, 6);
  return `${role}-${project || "project"}-${task || "task"}-${suffix || "run"}`.slice(0, 100);
}

function tmuxLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveTmuxSession(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHYARD_TMUX_SESSION || tmuxSessionForHome(resolveSwitchYardHome(env));
}

export const TMUX_SESSION = resolveTmuxSession();

export async function ensureSession(): Promise<void> {
  if (!(await hasSession())) {
    await tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", "__switchyard", "sleep 2147483647"]);
  }
}

export async function hasSession(): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", TMUX_SESSION]);
    return true;
  } catch {
    return false;
  }
}

export async function windowAlive(window: string): Promise<boolean> {
  const id = await findWindowId(window);
  if (!id) return false;
  try {
    const { stdout } = await tmux(["display-message", "-p", "-t", id, "#{pane_dead}"]);
    return stdout.trim() === "0";
  } catch {
    return false;
  }
}

async function findWindowId(window: string): Promise<string | undefined> {
  try {
    const { stdout } = await tmux([
      "list-windows",
      "-t",
      TMUX_SESSION,
      "-F",
      "#{window_id}\t#{window_name}",
    ]);
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf("\t");
      if (separator !== -1 && line.slice(separator + 1) === window) {
        return line.slice(0, separator);
      }
    }
  } catch {
    // A missing tmux session has no matching windows.
  }
  return undefined;
}

export async function ensureWindow(window: string, cwd: string, command: string): Promise<void> {
  if (!(await hasSession())) {
    await tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", window, "-c", cwd, command]);
    return;
  }
  if (await windowAlive(window)) return;
  if (await findWindowId(window)) await killWindow(window);
  await tmux(["new-window", "-d", "-t", TMUX_SESSION, "-n", window, "-c", cwd, command]);
}

export async function killWindow(window: string): Promise<void> {
  const id = await findWindowId(window);
  if (!id) return;
  try {
    await tmux(["kill-window", "-t", id]);
  } catch {
    // Missing windows are already stopped.
  }
}

export async function captureWindow(window: string): Promise<string> {
  const windowId = await findWindowId(window);
  if (!windowId) throw new Error(`tmux window not found: ${window}`);
  const { stdout } = await tmux(["capture-pane", "-p", "-t", windowId]);
  return stdout;
}

export async function attachWindow(window: string): Promise<number> {
  const windowId = await findWindowId(window);
  if (!windowId) throw new Error(`tmux window not found: ${window}`);
  const target = `${TMUX_SESSION}:${windowId}`;
  if (process.env.TMUX) {
    await tmux(["switch-client", "-t", target]);
    return 0;
  }
  return await new Promise<number>((resolve) => {
    const child = spawn("tmux", ["attach-session", "-t", target], { stdio: "inherit" });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function showWindowReadOnly(window: string): Promise<void> {
  const windowId = await findWindowId(window);
  if (!windowId) throw new Error(`tmux window not found: ${window}`);
  if (!/^@[0-9]+$/.test(windowId)) throw new Error("tmux returned an invalid window identifier");
  const viewer = [
    'const { spawnSync } = require("node:child_process");',
    "const target = process.argv[1];",
    'const draw = () => { const pane = spawnSync("tmux", ["capture-pane", "-e", "-p", "-t", target], { encoding: "utf8" }); process.stdout.write("\\x1b[H\\x1b[2J" + (pane.status === 0 ? pane.stdout : pane.stderr ?? "Unable to capture pane") + "\\nRead-only view; press q to return."); };',
    "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    'process.stdin.on("data", key => { if (key.includes(113)) process.exit(0); });',
    "draw(); setInterval(draw, 750);",
  ].join("");
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(viewer)} ${windowId}`;
  await tmux([
    "display-popup",
    "-E",
    "-w",
    "100%",
    "-h",
    "100%",
    "-T",
    "Read-only pane — press q to return",
    command,
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("tmux", args, { windowsHide: true });
}
