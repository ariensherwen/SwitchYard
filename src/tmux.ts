import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const TMUX_SESSION = process.env.SWITCHYARD_TMUX_SESSION || "switchyard";

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
  try {
    const { stdout } = await tmux([
      "display-message",
      "-p",
      "-t",
      `${TMUX_SESSION}:${window}`,
      "#{pane_dead}",
    ]);
    return stdout.trim() === "0";
  } catch {
    return false;
  }
}

async function windowExists(window: string): Promise<boolean> {
  try {
    await tmux(["display-message", "-p", "-t", `${TMUX_SESSION}:${window}`, "#{window_id}"]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWindow(window: string, cwd: string, command: string): Promise<void> {
  if (!(await hasSession())) {
    await tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", window, "-c", cwd, command]);
    return;
  }
  if (await windowAlive(window)) return;
  if (await windowExists(window)) await killWindow(window);
  await tmux(["new-window", "-d", "-t", TMUX_SESSION, "-n", window, "-c", cwd, command]);
}

export async function killWindow(window: string): Promise<void> {
  try {
    await tmux(["kill-window", "-t", `${TMUX_SESSION}:${window}`]);
  } catch {
    // Missing windows are already stopped.
  }
}

export async function attachWindow(window: string): Promise<number> {
  const target = `${TMUX_SESSION}:${window}`;
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

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("tmux", args, { windowsHide: true });
}
