#!/usr/bin/env bash
set -euo pipefail

if [[ "${SWITCHYARD_LIVE:-}" != "1" ]]; then
  echo "live e2e is opt-in; run with SWITCHYARD_LIVE=1" >&2
  exit 2
fi
for tool in node git tmux pi pgrep; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/switchyard-live.XXXXXX")"
export SWITCHYARD_HOME="$TMP/home"
export SWITCHYARD_TMUX_SESSION="switchyard-test-$$"
REPO="$TMP/repo"
CLI=(node "$ROOT_DIR/src/cli.ts")

cleanup() { tmux kill-session -t "$SWITCHYARD_TMUX_SESSION" 2>/dev/null || true; }
trap cleanup EXIT
fail() { echo "live e2e failed; preserved: $TMP" >&2; trap - EXIT; exit 1; }

mkdir -p "$REPO"
git -C "$REPO" init -b main >/dev/null
git -C "$REPO" config user.email switchyard-e2e@example.invalid
git -C "$REPO" config user.name "SwitchYard E2E"
printf 'base\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -m base >/dev/null

project_id="$("${CLI[@]}" project add "$REPO" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).id))')" || fail
[[ -n "$project_id" ]] || fail

task_json() { "${CLI[@]}" task show "$1"; }
task_state() { task_json "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).task.state))'; }
create_task() {
  "${CLI[@]}" task create "$project_id" --json "$@" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).task.id))'
}
json_field() {
  local task_id="$1" expr="$2"
  task_json "$task_id" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);const f=new Function("x",`return ${process.argv[1]}`);const v=f(x);if(v!==undefined&&v!==null)process.stdout.write(String(v));})' "$expr"
}

assert_runtime_quiesced() {
  local window="$1" window_id pane_pid start=$SECONDS timeout=30
  while (( SECONDS - start < timeout )); do
    if ! window_id="$(tmux list-windows -t "$SWITCHYARD_TMUX_SESSION" -F '#{window_id} #{window_name}' 2>/dev/null | awk -v name="$window" '$2 == name { print $1; exit }')"; then
      return 0
    fi
    [[ -z "$window_id" ]] && return 0
    if ! pane_pid="$(tmux display-message -p -t "$window_id" '#{pane_pid}' 2>/dev/null)"; then return 0; fi
    # tmux may leave its interactive shell pane alive after the Pi process exits.
    if ! pgrep -P "$pane_pid" -x pi >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "Pi runtime still active after ${timeout}s: $window" >&2
  fail
}

wait_state() {
  local task_id="$1" wanted="$2" timeout="${3:-180}" start now state last_reconcile
  start="$(date +%s)"
  last_reconcile="$start"
  while true; do
    state="$(task_state "$task_id")" || fail
    if [[ "$state" == "$wanted" ]]; then return 0; fi
    if [[ "$state" == "failed" || "$state" == "cancelled" ]]; then
      echo "task $task_id reached unexpected terminal state: $state" >&2
      task_json "$task_id" >&2 || true
      fail
    fi
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      echo "timed out waiting for $task_id -> $wanted; current=$state" >&2
      task_json "$task_id" >&2 || true
      fail
    fi
    if (( now - last_reconcile >= 5 )); then
      run_reconcile || fail
      last_reconcile="$now"
    fi
    sleep 1
  done
}

run_reconcile() {
  node --experimental-strip-types --input-type=module - "$ROOT_DIR" <<'NODE'
const root = process.argv[2];
const { openSwitchYard } = await import(`${root}/src/context.ts`);
const { reconcile } = await import(`${root}/src/reconcile.ts`);
const { paths, store } = await openSwitchYard();
try { await reconcile(store, paths); } finally { store.close(); }
NODE
}

supervisor_tool() {
  node --experimental-strip-types --input-type=module - "$ROOT_DIR" "$1" "$2" <<'NODE'
const [root, name, params] = process.argv.slice(2);
const { default: extension } = await import(`${root}/extensions/supervisor.ts`);
const tools = new Map();
extension({
  registerTool(tool) { tools.set(tool.name, tool); },
  on() {},
  async sendUserMessage() {},
  setActiveTools() {},
});
const tool = tools.get(name);
if (!tool) throw new Error(`Supervisor tool not registered: ${name}`);
const result = await tool.execute("live-e2e", JSON.parse(params));
process.stdout.write(result.content[0].text);
NODE
}

task_id_for_instruction() {
  node --experimental-strip-types --input-type=module - "$ROOT_DIR" "$1" <<'NODE'
const [root, instruction] = process.argv.slice(2);
const { openSwitchYard } = await import(`${root}/src/context.ts`);
const { store } = await openSwitchYard();
try {
  const task = store.listTasks().find((row) => row.instruction === instruction);
  if (task) process.stdout.write(task.id);
} finally { store.close(); }
NODE
}

echo "Live environment: $TMP"
echo "Project: Registered repo at $REPO"
echo "1/5 Supervisor natural-reference contract + original instruction dispatch"
basic_instruction='Append exactly one line live-e2e to README.md, commit the change, verify git status is clean, then call switchyard_complete.'
basic_output="$(supervisor_tool switchyard_delegate "{\"project\":\"repo\",\"kind\":\"implement\",\"instruction\":\"$basic_instruction\",\"review\":false}")" || fail
[[ "$basic_output" != *"task_id"* && ! "$basic_output" =~ [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} ]] || fail
basic_task="$(task_id_for_instruction "$basic_instruction")"
[[ -n "$basic_task" ]] || fail
supervisor_task="$(supervisor_tool switchyard_get_task '{"task":"repo live-e2e README.md"}')" || fail
[[ "$supervisor_task" == *'"project": "repo"'* && "$supervisor_task" != *"task_id"* ]] || fail
wait_state "$basic_task" completed
basic_workspace="$(json_field "$basic_task" 'x.workspace.path')"
grep -qx 'live-e2e' "$basic_workspace/README.md" || fail
assert_runtime_quiesced "task-$basic_task"

echo "2/5 idle steering + crash recovery with durable replacement context"
resume_task="$(create_task --kind implement --no-review 'On your first Worker turn, call switchyard_wait with reason awaiting-guidance before modifying files. After the Task resumes, follow the latest Worker message and do not wait again.')" || fail
wait_state "$resume_task" waiting
old_worker="$(json_field "$resume_task" 'x.events.filter(e=>e.type==="worker.started").at(-1) && JSON.parse(x.events.filter(e=>e.type==="worker.started").at(-1).payload_json).worker_id')"
tmux kill-window -t "$SWITCHYARD_TMUX_SESSION:task-$resume_task" || fail
"${CLI[@]}" task send "$resume_task" 'Create steering.txt containing steered, commit it, verify clean status, then call switchyard_complete.' || fail
new_worker="$(json_field "$resume_task" 'x.events.filter(e=>e.type==="worker.started").at(-1) && JSON.parse(x.events.filter(e=>e.type==="worker.started").at(-1).payload_json).worker_id')"
[[ -n "$old_worker" && -n "$new_worker" && "$old_worker" != "$new_worker" ]] || fail
wait_state "$resume_task" completed
resume_workspace="$(json_field "$resume_task" 'x.workspace.path')"
grep -qx 'steered' "$resume_workspace/steering.txt" || fail

echo "3/5 durable Decision answer wakes idle Worker"
decision_task="$(create_task --kind implement --no-review 'Immediately request a SwitchYard decision asking Which value? with options alpha and beta. After the answer arrives, create decision.txt containing the chosen value, commit it, verify clean status, then call switchyard_complete.')" || fail
wait_state "$decision_task" needs_decision
decision_id="$(json_field "$decision_task" 'x.decision.id')"
[[ -n "$decision_id" ]] || fail
"${CLI[@]}" task answer "$decision_task" "$decision_id" alpha || fail
wait_state "$decision_task" completed
decision_workspace="$(json_field "$decision_task" 'x.workspace.path')"
grep -qx 'alpha' "$decision_workspace/decision.txt" || fail

echo "4/5 real review loop reaches completed"
review_task="$(create_task --kind implement 'Create review.txt containing review-live, commit it, verify git status is clean, then call switchyard_complete. If review findings arrive, fix all findings, commit a new candidate, and call switchyard_complete again.')" || fail
wait_state "$review_task" completed 300
review_json="$(task_json "$review_task")"
grep -q '"state": "clean"' <<<"$review_json" || fail
assert_runtime_quiesced "task-$review_task"
review_window="$(json_field "$review_task" 'x.review.tmux_window')"
[[ -n "$review_window" ]] && assert_runtime_quiesced "$review_window"

echo "5/5 cancellation preserves committed work and cleanup refuses unlanded branch"
cancel_task="$(create_task --kind implement --no-review 'Create cancel.txt containing preserve-me, commit it, then call switchyard_wait with reason ready-for-cancel. Do not call switchyard_complete.')" || fail
wait_state "$cancel_task" waiting
cancel_workspace="$(json_field "$cancel_task" 'x.workspace.path')"
git -C "$cancel_workspace" log -1 --format=%B | grep -q . || fail
"${CLI[@]}" task cancel "$cancel_task" || fail
[[ "$(task_state "$cancel_task")" == "cancelled" ]] || fail
[[ -d "$cancel_workspace" ]] || fail
grep -qx 'preserve-me' "$cancel_workspace/cancel.txt" || fail
assert_runtime_quiesced "task-$cancel_task"
if "${CLI[@]}" task clean "$cancel_task"; then
  echo "cleanup unexpectedly removed unlanded cancellation work" >&2
  fail
fi
[[ -d "$cancel_workspace" ]] || fail

for task_id in "$basic_task" "$resume_task" "$decision_task" "$review_task" "$cancel_task"; do
  live_worker="$(json_field "$task_id" 'x.events.filter(e=>e.type==="worker.stopped").length')"
  [[ -n "$live_worker" ]] || fail
done

echo "Live e2e passed: autonomous dispatch, idle steering, Decision delivery, crash recovery, review completion, terminal runtime retirement, and nondestructive cancellation/cleanup."
echo "Temporary paths: $TMP"
