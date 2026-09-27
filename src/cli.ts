#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type DoctorReport, runDoctor } from "./doctor.js";

const SWITCHYARD_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUPERVISOR_PROMPT =
  "You are the SwitchYard Supervisor. Follow the Supervisor contract in CONTEXT.md. Do not claim capabilities that SwitchYard has not implemented.";

const HELP = `SwitchYard

Usage:
  switchyard
  switchyard <command>

Default:
  Launch Pi as the SwitchYard Supervisor

Commands:
  doctor    Check local SwitchYard prerequisites

Options:
  --help
  --version
`;

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
      strict: true,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (parsed.values.version) {
    console.log(await readPackageVersion());
    return 0;
  }

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (parsed.positionals.length === 0) {
    return await launchSupervisor();
  }

  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0) {
    console.error(`Unexpected argument: ${rest[0]}`);
    return 1;
  }

  if (command === "doctor") {
    const report = await runDoctor();
    process.stdout.write(formatDoctorReport(report));
    return report.ok ? 0 : 1;
  }

  console.error(`Unknown command: ${command}`);
  return 1;
}

async function launchSupervisor(): Promise<number> {
  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(code);
    };

    const child = spawn("pi", ["--append-system-prompt", SUPERVISOR_PROMPT], {
      cwd: SWITCHYARD_ROOT,
      env: {
        ...process.env,
        SWITCHYARD_HOME: SWITCHYARD_ROOT,
        SWITCHYARD_SUPERVISOR: "1",
      },
      stdio: "inherit",
    });

    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(
          "Pi is not installed or not available on PATH. Run `switchyard doctor` to check prerequisites.",
        );
      } else {
        console.error(`Failed to launch Pi: ${error.message}`);
      }

      finish(1);
    });

    child.once("close", (code) => finish(code ?? 1));
  });
}

async function readPackageVersion(): Promise<string> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version");
  }

  return packageJson.version;
}

function formatDoctorReport(report: DoctorReport): string {
  const rows = report.checks.map((check) => {
    const detail = check.version
      ? check.error
        ? `${check.version} (${check.error})`
        : check.version
      : (check.error ?? "unavailable");
    return `${check.tool.padEnd(5)} ${check.ok ? "ok" : "fail"}  ${detail}`;
  });

  return `SwitchYard doctor\n\n${rows.join("\n")}\n`;
}

process.exitCode = await main(process.argv.slice(2));
