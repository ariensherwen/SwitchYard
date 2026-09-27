#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runDoctor, type DoctorReport } from "./doctor.js";

const HELP = `SwitchYard

Usage:
  switchyard <command>

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

  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
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
