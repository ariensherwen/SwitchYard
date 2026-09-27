# SwitchYard context

## Project

A Git repository registered with SwitchYard. A Project may own many Tasks.

## Task

A durable unit of requested work. A Task survives worker death or replacement and has at most one active Worker at a time.

Initial task kinds are `implement` and `investigate`.

Canonical lifecycle:

| From | Allowed transitions |
| --- | --- |
| `queued` | `running`, `failed`, `cancelled` |
| `running` | `waiting`, `needs_decision`, `completed`, `failed`, `cancelled` |
| `waiting` | `running`, `failed`, `cancelled` |
| `needs_decision` | `running`, `failed`, `cancelled` |
| `completed` | none |
| `failed` | none |
| `cancelled` | none |

`waiting` and `needs_decision` are resumable states. `completed`, `failed`, and `cancelled` are terminal. A Task may be cancelled from any nonterminal state, including `queued` before a Worker starts. A Task may fail from any nonterminal state, including startup or recovery failure before an active Worker exists.

## Worker

One Pi process executing a Task. A replacement Pi process is a new Worker. A Task may have multiple Workers over its lifetime, but never more than one active Worker.

## Workspace

The Git worktree owned by a Task. The Workspace belongs to the Task, not the Worker. Worker failure and Task cancellation do not imply Workspace deletion.

## Supervisor

The primary Pi session controlling SwitchYard. The Supervisor may create, inspect, steer, cancel, and resolve decisions for Tasks. It does not directly implement work inside worker Workspaces.

## Message

A durable steering instruction sent from the Supervisor to a Worker. Once messaging exists, Messages must be recorded before delivery.

## Decision

A durable unresolved question requiring an answer before a Task can proceed. A Decision is not a Message.

## Event

An append-only audit record that something happened. Current state may be stored directly; SwitchYard is not required to be fully event-sourced. A durable state change and its corresponding Event must be committed in the same transaction so state and audit history cannot diverge.

## Pi session

A Pi conversation/runtime instance. Use `Pi session` when plain `session` would be ambiguous.

## tmux window

A process host and visibility surface. A tmux window is not authoritative task state. Do not infer semantic task completion, waiting, or failure from rendered terminal text when Pi can provide structured information.

## tmux session

A tmux process-hosting session. Use `tmux session` when plain `session` would be ambiguous.
