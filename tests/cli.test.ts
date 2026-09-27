import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectRoot, "src", "cli.ts");
const tsxCliPath = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("no arguments launches Pi as Supervisor from the SwitchYard root and propagates exit status", async () => {
  const env = await fakeSupervisorPath(23);
  const result = await runCli([], env);

  assert.equal(result.code, 23);

  const markers = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );

  assert.equal(path.resolve(markers.cwd ?? ""), projectRoot);
  assert.equal(path.resolve(markers.home ?? ""), projectRoot);
  assert.equal(markers.supervisor, "1");
  assert.match(markers.args ?? "", /--append-system-prompt/);
  assert.match(markers.args ?? "", /SwitchYard Supervisor/);
});

test("missing Pi fails cleanly", async () => {
  const env = await emptyPath();
  const result = await runCli([], env);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Pi is not installed or not available on PATH/);
  assert.match(result.stderr, /switchyard doctor/);
});

test("--help exits 0 without launching Pi", async () => {
  const env = await fakeSupervisorPath(31);
  const result = await runCli(["--help"], env);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /SwitchYard/);
  assert.match(result.stdout, /Launch Pi as the SwitchYard Supervisor/);
  assert.match(result.stdout, /doctor/);
  assert.doesNotMatch(result.stdout, /supervisor=/);
});

test("--version exits 0 and prints package.json version", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { version: string };
  const result = await runCli(["--version"]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test("unknown command exits non-zero", async () => {
  const result = await runCli(["launch"]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command: launch/);
});

test("doctor exit status propagates success", async () => {
  const env = await fakeDoctorPath(0);
  const result = await runCli(["doctor"], env);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /pi\s+ok/);
});

test("doctor exit status propagates failure", async () => {
  const env = await fakeDoctorPath(7);
  const result = await runCli(["doctor"], env);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /pi\s+fail/);
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, cliPath, ...args], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fakeDoctorPath(piExitCode: number): Promise<NodeJS.ProcessEnv> {
  const directory = await makeTempDirectory("switchyard-cli-doctor-");

  const tools = {
    node: { output: "v22.19.0", exitCode: 0 },
    git: { output: "git version 2.51.0", exitCode: 0 },
    tmux: { output: "tmux 3.5a", exitCode: 0 },
    pi: { output: piExitCode === 0 ? "0.86.0" : "broken", exitCode: piExitCode },
  };

  await Promise.all(
    Object.entries(tools).map(async ([name, fake]) => {
      const executable = path.join(directory, name);
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${fake.output}'\nexit ${fake.exitCode}\n`,
      );
      await chmod(executable, 0o755);
    }),
  );

  return {
    ...process.env,
    PATH: directory,
  };
}

async function fakeSupervisorPath(exitCode: number): Promise<NodeJS.ProcessEnv> {
  const directory = await makeTempDirectory("switchyard-cli-supervisor-");
  const executable = path.join(directory, "pi");

  await writeFile(
    executable,
    `#!/bin/sh
printf 'cwd=%s\\n' "$PWD"
printf 'home=%s\\n' "$SWITCHYARD_HOME"
printf 'supervisor=%s\\n' "$SWITCHYARD_SUPERVISOR"
printf 'args=%s\\n' "$*"
exit ${exitCode}
`,
  );
  await chmod(executable, 0o755);

  return {
    ...process.env,
    PATH: directory,
  };
}

async function emptyPath(): Promise<NodeJS.ProcessEnv> {
  const directory = await makeTempDirectory("switchyard-cli-empty-");
  return {
    ...process.env,
    PATH: directory,
  };
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
