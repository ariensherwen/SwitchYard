import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
);

async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--experimental-strip-types", cli, ...args],
      { cwd: root, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("help exposes the 0.1.0 task surface", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /project add/);
  assert.match(result.stdout, /task create/);
  assert.match(result.stdout, /task clean/);
});

test("version remains package 0.1.0", async () => {
  const result = await run(["--version"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("project add/list persists under SWITCHYARD_HOME", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-repo-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "switchyard-cli-home-"));
  dirs.push(repo, home);
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  const env = { ...process.env, SWITCHYARD_HOME: home };
  const added = await run(["project", "add", repo], env);
  assert.equal(added.code, 0);
  const id = added.stdout.split("\t")[0]?.trim();
  assert.ok(id);
  const listed = await run(["project", "list"], env);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(id));
  assert.match(listed.stdout, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
