import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DoctorTool = "node" | "git" | "tmux" | "pi";

export interface DoctorCheck {
  tool: DoctorTool;
  ok: boolean;
  version?: string;
  error?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface ToolSpec {
  tool: DoctorTool;
  command: string;
  args: string[];
  parseVersion: (output: string) => string;
  validate?: (version: string) => string | undefined;
}

const MINIMUM_NODE_VERSION = [22, 19, 0] as const;

const TOOL_SPECS: ToolSpec[] = [
  {
    tool: "node",
    command: "node",
    args: ["--version"],
    parseVersion: (output) => output.trim().replace(/^v/, ""),
    validate: validateNodeVersion,
  },
  {
    tool: "git",
    command: "git",
    args: ["--version"],
    parseVersion: (output) => output.trim().replace(/^git version\s+/, ""),
  },
  {
    tool: "tmux",
    command: "tmux",
    args: ["-V"],
    parseVersion: (output) => output.trim().replace(/^tmux\s+/, ""),
  },
  {
    tool: "pi",
    command: "pi",
    args: ["--version"],
    parseVersion: (output) => output.trim(),
  },
];

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks = await Promise.all(TOOL_SPECS.map((spec) => checkTool(spec, env)));
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function checkTool(spec: ToolSpec, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      env,
      windowsHide: true,
    });
    const output = `${stdout}${stderr}`.trim();
    const version = spec.parseVersion(output);

    if (!version) {
      return {
        tool: spec.tool,
        ok: false,
        error: "version command returned no version",
      };
    }

    const validationError = spec.validate?.(version);
    if (validationError) {
      return {
        tool: spec.tool,
        ok: false,
        version,
        error: validationError,
      };
    }

    return {
      tool: spec.tool,
      ok: true,
      version,
    };
  } catch (error) {
    return {
      tool: spec.tool,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateNodeVersion(version: string): string | undefined {
  const parsed = parseSemverCore(version);
  if (!parsed) {
    return `unrecognized Node version: ${version}`;
  }

  if (compareVersion(parsed, MINIMUM_NODE_VERSION) < 0) {
    return "requires Node >= 22.19.0";
  }

  return undefined;
}

function parseSemverCore(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }

  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }

  return [Number(major), Number(minor), Number(patch)];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (const index of [0, 1, 2] as const) {
    const delta = left[index] - right[index];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}
