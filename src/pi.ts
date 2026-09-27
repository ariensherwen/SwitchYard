import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type PiRole = "supervisor" | "worker" | "reviewer";

export interface PiLaunch {
  cwd: string;
  command: string[];
  env: NodeJS.ProcessEnv;
}

export function buildPiLaunch(
  role: PiRole,
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  prompt?: string,
): PiLaunch {
  const extension = path.join(PACKAGE_ROOT, "extensions", `${role}.ts`);
  const args = ["pi", "-e", extension];
  if (prompt) args.push("--append-system-prompt", prompt);
  return {
    cwd,
    command: args,
    env: {
      ...process.env,
      ...extraEnv,
      SWITCHYARD_ROLE: role,
    },
  };
}

export function shellCommand(launch: PiLaunch): string[] {
  return [
    "env",
    ...Object.entries(launch.env)
      .filter(([key, value]) => key.startsWith("SWITCHYARD_") && value !== undefined)
      .map(([key, value]) => `${key}=${value}`),
    ...launch.command,
  ];
}
