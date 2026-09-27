#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node scripts/test-fresh-link.mjs
npm ci
npm run check
npm run build
node dist/cli.js --version
