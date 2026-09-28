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
const MINIMUM_PI_VERSION = [0, 87, 1] as const;

const TOOL_SPECS: ToolSpec[] = [
  {
    tool: "node",
    command: "node",
    args: ["--version"],
    parseVersion: (output) => output.trim().replace(/^v/, ""),
    validate: (version) => validateMinimum(version, MINIMUM_NODE_VERSION, "Node"),
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
    parseVersion: (output) => output.trim().replace(/^v/, ""),
    validate: (version) => validateMinimum(version, MINIMUM_PI_VERSION, "Pi"),
  },
];

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks = await Promise.all(TOOL_SPECS.map((spec) => checkTool(spec, env)));
  return { ok: checks.every((check) => check.ok), checks };
}

async function checkTool(spec: ToolSpec, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      env,
      windowsHide: true,
    });
    const version = spec.parseVersion(`${stdout}${stderr}`.trim());
    if (!version) {
      return { tool: spec.tool, ok: false, error: "version command returned no version" };
    }
    const error = spec.validate?.(version);
    return error
      ? { tool: spec.tool, ok: false, version, error }
      : { tool: spec.tool, ok: true, version };
  } catch (error) {
    return {
      tool: spec.tool,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateMinimum(
  version: string,
  minimum: readonly [number, number, number],
  name: string,
): string | undefined {
  const parsed = parseSemverCore(version);
  if (!parsed) return `unrecognized ${name} version: ${version}`;
  return compareVersion(parsed, minimum) < 0
    ? `requires ${name} >= ${minimum.join(".")}`
    : undefined;
}

function parseSemverCore(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}
