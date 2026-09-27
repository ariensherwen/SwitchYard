import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const TMUX_SESSION = process.env.SWITCHYARD_TMUX_SESSION || "switchyard";

export async function ensureSession(): Promise<void> {
  if (!(await hasSession())) await tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", "supervisor"]);
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
    await tmux(["display-message", "-p", "-t", `${TMUX_SESSION}:${window}`, "#{pane_dead}"]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWindow(window: string, cwd: string, command: string[]): Promise<void> {
  await ensureSession();
  if (await windowAlive(window)) return;
  await tmux(["new-window", "-d", "-t", TMUX_SESSION, "-n", window, "-c", cwd, ...command]);
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

export async function sendWake(window: string): Promise<void> {
  // This is intentionally a wake signal only. Durable messages remain in SQLite.
  try {
    await tmux(["send-keys", "-t", `${TMUX_SESSION}:${window}`, "C-l"]);
  } catch {
    // Missing wake is harmless; reconciliation/durable polling will deliver later.
  }
}

async function tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("tmux", args, { windowsHide: true });
}
