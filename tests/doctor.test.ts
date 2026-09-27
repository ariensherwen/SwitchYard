import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runDoctor } from "../src/doctor.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("reports all tools present", async () => {
  const env = await fakePath({
    node: "v22.19.0",
    git: "git version 2.51.0",
    tmux: "tmux 3.5a",
    pi: "0.86.0",
  });

  const report = await runDoctor(env);

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(({ tool, ok, version }) => ({ tool, ok, version })),
    [
      { tool: "node", ok: true, version: "22.19.0" },
      { tool: "git", ok: true, version: "2.51.0" },
      { tool: "tmux", ok: true, version: "3.5a" },
      { tool: "pi", ok: true, version: "0.86.0" },
    ],
  );
});

for (const missingTool of ["pi", "tmux", "git"] as const) {
  test(`reports ${missingTool} missing`, async () => {
    const env = await fakePath(
      {
        node: "v22.19.0",
        git: "git version 2.51.0",
        tmux: "tmux 3.5a",
        pi: "0.86.0",
      },
      new Set([missingTool]),
    );

    const report = await runDoctor(env);

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.tool === missingTool)?.ok, false);
  });
}

test("reports multiple missing tools in one run", async () => {
  const env = await fakePath(
    {
      node: "v22.19.0",
      git: "git version 2.51.0",
      tmux: "tmux 3.5a",
      pi: "0.86.0",
    },
    new Set(["git", "tmux", "pi"]),
  );

  const report = await runDoctor(env);

  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 4);
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => check.tool),
    ["git", "tmux", "pi"],
  );
});

test("reports a failing version command", async () => {
  const env = await fakePath({
    node: "v22.19.0",
    git: "git version 2.51.0",
    tmux: "tmux 3.5a",
    pi: { output: "broken", exitCode: 9 },
  });

  const report = await runDoctor(env);
  const pi = report.checks.find((check) => check.tool === "pi");

  assert.equal(report.ok, false);
  assert.equal(pi?.ok, false);
  assert.match(pi?.error ?? "", /Command failed/);
});

test("reports every failure even when version commands fail", async () => {
  const env = await fakePath({
    node: { output: "v22.18.0", exitCode: 0 },
    git: { output: "git broken", exitCode: 2 },
    tmux: { output: "tmux broken", exitCode: 3 },
    pi: { output: "pi broken", exitCode: 4 },
  });

  const report = await runDoctor(env);

  assert.equal(report.ok, false);
  assert.equal(report.checks.filter((check) => !check.ok).length, 4);
});

type FakeTool = string | { output: string; exitCode: number };
type FakeTools = Record<"node" | "git" | "tmux" | "pi", FakeTool>;

async function fakePath(
  tools: FakeTools,
  missing: ReadonlySet<keyof FakeTools> = new Set(),
): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "switchyard-doctor-"));
  tempDirectories.push(directory);

  await Promise.all(
    Object.entries(tools).map(async ([name, fake]) => {
      if (missing.has(name as keyof FakeTools)) {
        return;
      }

      const { output, exitCode } =
        typeof fake === "string" ? { output: fake, exitCode: 0 } : fake;
      const executable = path.join(directory, name);
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' ${shellQuote(output)}\nexit ${exitCode}\n`,
      );
      await chmod(executable, 0o755);
    }),
  );

  return {
    ...process.env,
    PATH: directory,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
