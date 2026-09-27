import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SwitchYardPaths {
  home: string;
  database: string;
  supervisor: string;
  worktrees: string;
  reviews: string;
  wake: string;
}

export function resolveSwitchYardHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SWITCHYARD_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".switchyard"));
}

export function getSwitchYardPaths(env: NodeJS.ProcessEnv = process.env): SwitchYardPaths {
  const home = resolveSwitchYardHome(env);
  return {
    home,
    database: path.join(home, "switchyard.db"),
    supervisor: path.join(home, "supervisor"),
    worktrees: path.join(home, "worktrees"),
    reviews: path.join(home, "reviews"),
    wake: path.join(home, "wake"),
  };
}

export async function ensureSwitchYardHome(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwitchYardPaths> {
  const paths = getSwitchYardPaths(env);
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.supervisor, { recursive: true }),
    mkdir(paths.worktrees, { recursive: true }),
    mkdir(paths.reviews, { recursive: true }),
    mkdir(paths.wake, { recursive: true }),
  ]);
  return paths;
}
