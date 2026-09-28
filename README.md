# SwitchYard

SwitchYard lets a global Pi Supervisor coordinate coding Tasks in registered local Git Projects. Workers run in task-owned Git worktrees; SQLite holds durable state, Messages, Decisions, and Events. tmux hosts the Pi sessions but is not a source of Task state.

## Requirements

- Node.js >= 22.19
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

## Talk to the Supervisor

Run `switchyard` from any directory. It opens the same home-scoped Supervisor; the launch directory is not treated as a Project.

```text
$ switchyard
You: Register ~/work/kinetix as Kinetix, then fix issue #142.
Supervisor: I found uncommitted changes in Kinetix. Should I leave them untouched and start from committed HEAD?
You: Yes.
Supervisor: I started “Fix Kinetix issue #142”. It will go through implementation review before I report completion.
```

The Supervisor can register, create, rename, inspect, relocate, and unregister Projects; manage Git remotes; start and steer Tasks; resolve Decisions; and show live Worker or Reviewer panes. Worker and Reviewer panes are observational: send steering and answer Decisions through the Supervisor. It uses Project names and Task titles rather than internal IDs. If a name is ambiguous, it asks you to choose.

Implementation Tasks run the review loop by default. Investigation Tasks use a pinned, temporary checkout and cannot submit source changes. Remote implementation requires consent to clone and register a Project. Inspecting a remote without registering it requires a concrete commit SHA.

## Explicit integration

A completed Task stays in its Workspace until you ask to land or publish it.

- “Land the Kinetix fix” fast-forwards the current Project branch only if its checkout is clean and still at the Task's captured base. If the Project advanced, SwitchYard refuses; it does not merge or rebase for you.
- “Push the candidate to origin as `fix/issue-142`” publishes the exact reviewed candidate to that branch. Publishing does not open or merge a PR.

## CLI and state

The CLI remains available for setup, diagnostics, recovery, and scripts:

```sh
switchyard project add /path/to/repo
switchyard project list
switchyard task list
switchyard doctor
switchyard recover
```

Use `switchyard --help` for the full command surface. Normal output uses Project names and Task titles. Add `--json` to supported commands when a script needs internal IDs.

SwitchYard stores state under `${SWITCHYARD_HOME:-~/.switchyard}`. Set `SWITCHYARD_HOME` to use a separate home. Terminal Task Workspaces remain available until safely cleaned or landed. A transient source is removed after terminal completion only when its pinned checkout and Workspace are unchanged; uncertain or dirty work is preserved.

## Development

Run the deterministic merge gate locally:

```sh
./scripts/run-ci.sh
```

Real Pi/tmux acceptance is opt-in:

```sh
SWITCHYARD_LIVE=1 ./scripts/run-live-e2e.sh
```

SwitchYard currently targets local Pi sessions, tmux, Git worktrees, and SQLite. It does not provide remote Workers, alternate runtimes, scheduling, multi-user execution, or PR automation.
