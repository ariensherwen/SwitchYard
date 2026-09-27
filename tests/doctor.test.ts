import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runDoctor } from "../src/doctor.ts";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

test("requires Pi >= 0.87.1", async () => {
  const report = await runDoctor(await fakePath({ node: "v22.19.0", git: "git version 2.51.0", tmux: "tmux 3.5a", pi: "0.87.0" }));
  assert.equal(report.ok, false);
  assert.match(report.checks.find((c) => c.tool === "pi")?.error ?? "", /Pi >= 0\.87\.1/);
});

test("accepts supported prerequisites", async () => {
  const report = await runDoctor(await fakePath({ node: "v22.19.0", git: "git version 2.51.0", tmux: "tmux 3.5a", pi: "0.87.1" }));
  assert.equal(report.ok, true);
});

async function fakePath(tools: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "switchyard-doctor-")); dirs.push(dir);
  for (const [name, output] of Object.entries(tools)) {
    const file = path.join(dir, name); await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`); await chmod(file, 0o755);
  }
  return { ...process.env, PATH: dir };
}
