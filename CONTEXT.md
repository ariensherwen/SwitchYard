# SwitchYard context

## Project

A human-named local Git checkout registered with SwitchYard. Its canonical top-level real path and a Git-configured repository identity bind registration to that checkout; its name is a label, not an identifier, and need not be unique. Git remotes are ordinary repository configuration, not Project identity. A Project can be unregistered without deleting it; it remains available to historical Tasks and can be registered again from its current checkout. Generated Workspaces and transient Task Sources are not Projects. Implementation Tasks require a registered Project. A newly created empty Project starts with a clean empty baseline commit so its first Task has a stable base.

## Task

A durable unit of requested work with a mutable human-facing title and immutable internal UUID identity. Kinds are `implement` and `investigate`. A Task uses either a registered Project or its own transient Source checkout. Its selected base ref and captured base SHA do not move after startup; a dirty Project checkout requires explicit acknowledgement to use committed HEAD while leaving local changes untouched.

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

`completed`, `failed`, and `cancelled` are terminal. Terminal Tasks are never resurrected, and terminalizing a Task cancels its open Decision and aborts any running Review in the same transaction. `starting` covers durable Workspace reservation/provisioning and Worker startup. Recovery resumes `queued` Tasks and completes interrupted Workspace provisioning. `reviewing` means one candidate revision is under independent review.

## Source

A transient, read-only remote Git checkout owned by an `investigate` Task. It is pinned to one full commit SHA and is not a registered Project. SwitchYard may remove a terminal Task's transient Source only after positively verifying that its checkout and Workspace remain unchanged; uncertain or dirty work is preserved.

## Workspace

One Git worktree owned by one Task. Its path, branch, and base revision are reserved durably before Git creates it, then marked provisioned once creation is verified. The Workspace belongs to the Task, not a Worker, and survives Worker replacement and cancellation. Cleanup must prove that no unlanded work will be destroyed.

## Worker

One Pi process executing a Task. A replacement Pi process receives a new Worker identity and continues in the same Workspace. A Task may have many historical Workers but at most one active Worker.

A Reviewer is not a Worker.

## Supervisor

The global liaison Pi session controlling SwitchYard. It is not bound to the launch directory or a current Project. It refers to Projects by name and Tasks by title or natural description, never requires internal IDs in human conversation, and receives human-readable records. It delegates, inspects, steers, renames, resolves Decisions, and cancels Tasks without taking Worker or Reviewer authority. Unknown local checkouts enter registration intake. Remote implementation requires explicit clone-and-register consent; remote investigation uses a concrete pinned commit without registering the source.

## Message

A durable steering or notification record. State is `pending` or `delivered`. Persistence precedes delivery; a missed wake signal does not lose the Message.

## Decision

A durable question that blocks a Task. State is `open`, `resolved`, or `cancelled`. Resolving a Decision atomically records the answer, resumes the Task, queues the answer Message, and records Events. Terminalizing its Task cancels an open Decision atomically.

## Candidate revision

The exact committed Git SHA submitted by a Worker as the result of an `implement` Task. Completion, Review certification, landing, and publication bind to this revision.

## Review policy

`off` or `loop`. `loop` is the default for `implement` Tasks and is supported only for that kind; `investigate` Tasks use `off`.

## Review

An independent evaluation of one exact candidate revision. States are `running`, `changes_requested`, `clean`, and `failed`. A clean Review certifies only its candidate SHA.

## Finding

An immutable actionable problem reported by one Review. A later Review determines whether a newer candidate is clean; old Findings are not rewritten based on Worker claims.

## Landing

An explicitly requested fast-forward of a completed implementation candidate into the registered Project's current branch. The Project checkout must be clean and its HEAD must still equal the Task's captured base SHA. If it advanced, SwitchYard refuses without merging or rebasing; integration is separate work.

## Publication

An explicitly requested push of the exact completed candidate to selected Git remote(s) under a human-readable branch name. Publication does not open or merge a pull request.

## Event

Append-only audit history. Current state is stored directly; SwitchYard is not fully event-sourced. A durable state transition and its corresponding Event commit in the same SQLite transaction.

## Pi session

A Pi conversation/runtime instance. Use `Pi session` when plain `session` would be ambiguous.

## tmux session

A process-hosting session namespaced by the canonical SwitchYard home. tmux is not semantic state: pane text never proves Task completion, waiting, failure, or Decision state.
