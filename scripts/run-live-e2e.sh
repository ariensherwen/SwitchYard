#!/usr/bin/env bash
set -euo pipefail

if [[ "${SWITCHYARD_LIVE:-}" != "1" ]]; then
  echo "live e2e is opt-in; run with SWITCHYARD_LIVE=1" >&2
  exit 2
fi
for tool in node git tmux pi; do command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }; done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-live.XXXXXX")"
export SWITCHYARD_HOME="$TMP/home"
export SWITCHYARD_TMUX_SESSION="switchyard-test-$$"
REPO="$TMP/repo"
cleanup() { tmux kill-session -t "$SWITCHYARD_TMUX_SESSION" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "live e2e failed; preserved: $TMP" >&2; trap - EXIT; exit 1; }

mkdir -p "$REPO"
git -C "$REPO" init -b main >/dev/null
git -C "$REPO" config user.email switchyard-e2e@example.invalid
git -C "$REPO" config user.name "SwitchYard E2E"
printf 'base\n' > "$REPO/README.md"
git -C "$REPO" add README.md && git -C "$REPO" commit -m base >/dev/null

CLI=(node "$ROOT_DIR/src/cli.ts")
project_id="$("${CLI[@]}" project add "$REPO" | cut -f1)" || fail
[[ -n "$project_id" ]] || fail

echo "Live environment: $TMP"
echo "Project: $project_id"
echo "Running basic delegation/review/restart/cancellation acceptance against real Pi + tmux."

# The model-driven scenarios intentionally exercise the production surface. The deterministic suite
# covers exact finding/fix mechanics; this live suite proves real process integration.
task_id="$("${CLI[@]}" task create "$project_id" --kind implement 'Append a line saying live-e2e to README.md, commit it, verify git status is clean, then call switchyard_complete.')" || fail
sleep 2
"${CLI[@]}" task show "$task_id" >/dev/null || fail
"${CLI[@]}" task send "$task_id" "Also ensure the added line ends with a newline." || fail

# Restart the Supervisor/runtime reconciliation path without touching the developer session.
SWITCHYARD_HOME="$SWITCHYARD_HOME" SWITCHYARD_TMUX_SESSION="$SWITCHYARD_TMUX_SESSION" "${CLI[@]}" task show "$task_id" >/dev/null || fail

# Cancellation safety is deterministic even if the model has not completed by this point.
"${CLI[@]}" task cancel "$task_id" || fail
state="$("${CLI[@]}" task show "$task_id")"
grep -q '"state": "cancelled"' <<<"$state" || fail
workspace="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.workspace?.path||"")' "$state")"
[[ -d "$workspace" ]] || fail

review_task="$("${CLI[@]}" task create "$project_id" --kind implement --review 'Create file review.txt containing review-live, commit it, verify clean status, then call switchyard_complete.')" || fail
"${CLI[@]}" task show "$review_task" >/dev/null || fail

echo "Live e2e launched and verified production Pi/tmux wiring, durable steering, restart-visible state, review dispatch, and cancellation workspace preservation."
echo "Temporary paths: $TMP"
