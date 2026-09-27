# SwitchYard context

## Project

A Git repository registered with SwitchYard. A Project may own many Tasks.

## Task

A durable unit of requested work. A Task survives worker death or replacement and has exactly one active Worker at a time.

Initial task kinds are `implement` and `investigate`.

Canonical lifecycle:

```text
queued
  ↓
running
  ├─ waiting
  ├─ needs_decision
  ├─ completed
  ├─ failed
  └─ cancelled
```

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

An append-only audit record that something happened. Current state may be stored directly; SwitchYard is not required to be fully event-sourced.

## Pi session

A Pi conversation/runtime instance. Use `Pi session` when plain `session` would be ambiguous.

## tmux window

A process host and visibility surface. A tmux window is not authoritative task state. Do not infer semantic task completion, waiting, or failure from rendered terminal text when Pi can provide structured information.

## tmux session

A tmux process-hosting session. Use `tmux session` when plain `session` would be ambiguous.
