# SwitchYard

A local control plane for running and supervising Pi coding workers in tmux with isolated Git worktrees and durable task state.

## Status

0.1.0 is under development.

## What it is

```text
Pi supervisor
    ↓
SwitchYard
    ↓
  tmux
    ↓
Pi workers
    ↓
isolated Git worktrees
```

## 0.1.0 scope

SwitchYard 0.1.0 is Pi-first, tmux-first, local-only, and targets Linux and macOS. The intended 0.1.0 scope includes Git worktrees, durable task state, steering, decisions, and restart recovery.

Only the bootstrap CLI and prerequisite checks are implemented in this repository foundation. Task persistence, worktree lifecycle, tmux/Pi worker orchestration, steering, decisions, and recovery are not implemented yet.

## Requirements

- Node >= 22.19
- Git
- tmux
- Pi

## Development

```sh
npm ci
npm run check
npm run build
```

Run the local package binary through npm with `--` so CLI flags are forwarded to SwitchYard instead of being consumed by `npm exec`:

```sh
npm exec -- switchyard --help
npm exec -- switchyard --version
npm exec -- switchyard doctor
```

## Current CLI

When `switchyard` is installed or linked on `PATH`:

```sh
switchyard --help
switchyard --version
switchyard doctor
```

`switchyard doctor` checks Node, Git, tmux, and Pi without installing software, changing user configuration, checking model credentials, or contacting model providers.

## Design

Agents reason; SwitchYard coordinates. tmux hosts workers, durable state owns lifecycle, and each task gets an isolated Git worktree. Maintainers should use `AGENTS.md` for repository guidance and `CONTEXT.md` for canonical domain terminology.
