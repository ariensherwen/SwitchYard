#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const sourcePath = path.join(packageRoot, "src", "cli.ts");
const { main } = await import(pathToFileURL(sourcePath).href);

process.exitCode = await main(process.argv.slice(2));
