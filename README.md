# SwitchYard

SwitchYard is a local control plane for supervising Pi coding workers in tmux with durable SQLite state and task-owned Git worktrees.

## Requirements

- Node >= 22.19
- Git
- tmux
- Pi >= 0.87.1
- Linux or macOS

Install from a checkout:

```sh
git clone https://github.com/PrightCord/SwitchYard.git
cd SwitchYard
npm link
switchyard doctor
```

## Launch

```sh
switchyard
```

SwitchYard initializes `${SWITCHYARD_HOME:-~/.switchyard}`, reconciles durable state, ensures the dedicated `switchyard` tmux session, starts the Supervisor Pi from `$SWITCHYARD_HOME/supervisor`, and attaches to it. Running the command from inside tmux switches the current client instead of nesting sessions.

Set a different state root with:

```sh
SWITCHYARD_HOME=/custom/path switchyard
```

## Projects and tasks

Register a Git checkout:

```sh
switchyard project add /path/to/repo
switchyard project list
```

Create and immediately dispatch work:

```sh
switchyard task create <project-id> "Implement the requested change"
switchyard task create <project-id> --kind investigate "Investigate the failure"
switchyard task create <project-id> --review "Implement and independently review the change"
```

Each Task owns one worktree under `$SWITCHYARD_HOME/worktrees/<project-id>/<task-id>` on branch `switchyard/task-<task-id>`. The registered Project checkout must be clean when a Task starts.

Inspect and steer tasks:

```sh
switchyard task list
switchyard task show <task-id>
switchyard task send <task-id> "Additional instruction"
switchyard task answer <task-id> <decision-id> "Human answer"
switchyard task attach <task-id>
switchyard task cancel <task-id>
switchyard task clean <task-id>
```

Messages and Decision answers are stored before delivery. Cancellation stops active runtimes but preserves the task Workspace. `task clean` refuses deletion when the task branch contains commits that are not ancestors of the registered Project's current HEAD; there is no force cleanup in 0.1.0.

## Completion and review

Workers complete through structured SwitchYard tools rather than terminal prose. Implement Tasks must submit a clean committed candidate on the expected branch that descends from the captured base revision.

Review is opt-in with `--review` and is available only for `implement` Tasks. Every review runs in a fresh Pi session and detached review worktree at one exact candidate SHA. A clean result is accepted only when it covers the complete changed-path set, contains no findings, the review checkout is clean, and the Worker Workspace still points at the reviewed candidate. Findings return the Task to its Worker for another revision.

## Durable state and recovery

SQLite state lives at `$SWITCHYARD_HOME/switchyard.db` with foreign keys, WAL, and a busy timeout enabled. SwitchYard persists Projects, Tasks, Workspaces, Worker history, Messages, Decisions, Reviews, Findings, and Events.

Startup reconciliation preserves waiting Decisions, does not resurrect terminal Tasks, replaces missing Workers in the same task-owned Workspace, restarts interrupted Reviews for the same candidate, and fails a nonterminal Task rather than silently recreating a missing Workspace.

## Development

Deterministic merge gate:

```sh
./scripts/run-ci.sh
```

All CI is run locally through `./scripts/run-ci.sh`; SwitchYard does not use GitHub Actions as a merge gate.

Opt-in live Pi/tmux acceptance:

```sh
SWITCHYARD_LIVE=1 ./scripts/run-live-e2e.sh
```

The deterministic suite covers domain, SQLite, real Git, review, role separation, CLI, and tmux integration when tmux is installed. The live suite uses a disposable repository, disposable `SWITCHYARD_HOME`, and a unique tmux session.

## 0.1.0 limits

0.1.0 is deliberately Pi + tmux + local Git worktrees. It does not provide remote workers, alternate agent/runtime backends, model routing, per-task model selection, multiple reviewers, a scheduler, a dashboard, PR automation, or multi-user execution.
