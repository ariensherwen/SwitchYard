import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "switchyard-link-smoke-"));
const checkout = path.join(tempRoot, "checkout");
const prefix = path.join(tempRoot, "prefix");

try {
  await cp(projectRoot, checkout, {
    recursive: true,
    filter(source) {
      const relative = path.relative(projectRoot, source);
      if (!relative) {
        return true;
      }

      const first = relative.split(path.sep, 1)[0];
      return first !== ".git" && first !== "node_modules";
    },
  });
  await mkdir(prefix, { recursive: true });
  await symlink(path.join(projectRoot, "node_modules"), path.join(checkout, "node_modules"), "dir");

  await run("npm", ["link"], {
    cwd: checkout,
    env: {
      ...process.env,
      npm_config_prefix: prefix,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    stdio: "inherit",
  });

  await run("npm", ["run", "build"], {
    cwd: checkout,
    env: process.env,
    stdio: "inherit",
  });

  const cliPath = path.join(checkout, "src", "cli.ts");
  const source = await readFile(cliPath, "utf8");
  const versionOutput = "console.log(await readPackageVersion());";
  assert.ok(source.includes(versionOutput), "CLI version output should be present in source");
  await writeFile(cliPath, source.replace(versionOutput, 'console.log("source-updated");'));

  const binary = path.join(prefix, "bin", "switchyard");
  const result = await run(binary, ["--version"], {
    cwd: tempRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });

  assert.equal(result.stdout.trim(), "source-updated");
  console.log("linked-source smoke: built then observed updated source behavior");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }

      reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}
