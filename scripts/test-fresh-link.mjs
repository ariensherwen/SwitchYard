import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

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
      return first !== ".git" && first !== "node_modules" && first !== "dist";
    },
  });
  await mkdir(prefix, { recursive: true });

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

  const binary = path.join(prefix, "bin", "switchyard");
  const result = await run(binary, ["--version"], {
    cwd: tempRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });

  assert.equal(result.stdout.trim(), packageJson.version);
  console.log(`fresh-link smoke: switchyard ${packageJson.version}`);
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
