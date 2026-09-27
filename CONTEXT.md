# SwitchYard context

## Project

A named, registered Git checkout managed by SwitchYard. Registration stores its display name, canonical Git top-level real path, and optional source URL for an explicit clone. Generated SwitchYard worktrees are not Projects. A remote URL is not a Project until the human approves cloning; a review-only choice creates no clone, registration, or Task.

## Task

A durable unit of requested work. Kinds are `implement` and `investigate`.

| From | Allowed transitions |
| --- | --- |
| `queued` | `starting`, `failed`, `cancelled` |
| `starting` | `running`, `failed`, `cancelled` |
| `running` | `waiting`, `needs_decision`, `reviewing`, `completed`, `failed`, `cancelled` |
| `waiting` | `running`, `failed`, `cancelled` |
| `needs_decision` | `running`, `failed`, `cancelled` |
| `reviewing` | `running`, `needs_decision`, `completed`, `failed`, `cancelled` |
| `completed` | none |
| `failed` | none |
| `cancelled` | none |

`completed`, `failed`, and `cancelled` are terminal. Terminal Tasks are never resurrected. `starting` covers durable Workspace reservation/provisioning and Worker startup. Recovery resumes `queued` Tasks and completes interrupted Workspace provisioning. `reviewing` means one candidate revision is under independent review. If a Task becomes terminal during a Review, the Review is durably aborted in the same transaction; runtime/worktree cleanup follows.

## Workspace

One Git worktree owned by one Task. Its path, branch, and base revision are reserved durably before Git creates it, then marked provisioned once creation is verified. The Workspace belongs to the Task, not a Worker, and survives Worker replacement and cancellation.

## Worker

One Pi process executing a Task. A replacement Pi process receives a new Worker identity and continues in the same Workspace. A Task may have many historical Workers but at most one active Worker.

A Reviewer is not a Worker.

## Supervisor

The primary Pi session controlling SwitchYard. It refers to Projects by name and Tasks by natural descriptions, never requires Task or Decision IDs, and receives human-readable records without internal IDs. It delegates, inspects, steers, resolves Decisions, and cancels Tasks without directly taking Worker or Reviewer authority. Unknown Projects enter intake; unknown remote URLs require an explicit clone or review-only choice, and cloning requires a name and destination.

## Message

A durable steering or notification record. State is `pending` or `delivered`. Persistence precedes delivery; a missed wake signal does not lose the Message.

## Decision

A durable question that blocks a Task. State is `open` or `resolved`. Resolving a Decision atomically records the answer, resumes the Task, queues the answer Message, and records Events.

## Candidate revision

The exact committed Git SHA submitted by a Worker as the result of an `implement` Task. Completion and review certification bind to this revision.

## Review policy

`off` or `loop`, default `off`. `loop` is supported only for `implement` Tasks in 0.1.0.

## Review

An independent evaluation of one exact candidate revision. States are `running`, `changes_requested`, `clean`, and `failed`. A clean Review certifies only its candidate SHA.

## Finding

An immutable actionable problem reported by one Review. A later Review determines whether a newer candidate is clean; old Findings are not rewritten based on Worker claims.

## Event

Append-only audit history. Current state is stored directly; SwitchYard is not fully event-sourced. A durable state transition and its corresponding Event commit in the same SQLite transaction.

## Pi session

A Pi conversation/runtime instance. Use `Pi session` when plain `session` would be ambiguous.

## tmux session

The `switchyard` process-hosting session. tmux is not semantic state: pane text never proves Task completion, waiting, failure, or Decision state.
