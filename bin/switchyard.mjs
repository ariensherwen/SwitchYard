#!/usr/bin/env node

import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const distPath = path.join(packageRoot, "dist", "cli.js");
const sourcePath = path.join(packageRoot, "src", "cli.ts");

let entrypoint = sourcePath;

try {
  await access(distPath);
  entrypoint = distPath;
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

await import(pathToFileURL(entrypoint).href);
