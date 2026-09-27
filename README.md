# SwitchYard

A local control plane for running and supervising Pi coding workers in tmux with isolated Git worktrees and durable task state.

## Status

0.1.0 is under development.

The bootstrap currently launches the Supervisor Pi and provides prerequisite diagnostics. Task persistence, worktree lifecycle, tmux/Pi worker orchestration, steering, decisions, and recovery are not implemented yet.

## What it is

```text
you
 ↓
SwitchYard Supervisor (Pi)
 ↓
SwitchYard
 ↓
tmux
 ↓
Pi workers
 ↓
isolated Git worktrees
```

## Quick start

Requirements:

- Node >= 22.19
- Git
- tmux
- Pi

Clone and link SwitchYard:

```sh
git clone https://github.com/PrightCord/SwitchYard.git
cd SwitchYard
npm link
```

Then launch the Supervisor:

```sh
switchyard
```

SwitchYard starts Pi from the SwitchYard installation root with the Supervisor role. The linked package builds itself through npm's `prepare` lifecycle; npm installs the package's development dependencies when linking from the package root.

## Current CLI

```sh
switchyard
switchyard --help
switchyard --version
switchyard doctor
```

`switchyard doctor` checks Node, Git, tmux, and Pi without installing software, changing user configuration, checking model credentials, or contacting model providers.

For development without a global link, use npm's argument separator so flags are forwarded to SwitchYard:

```sh
npm exec -- switchyard --help
npm exec -- switchyard --version
npm exec -- switchyard doctor
```

## Development

Run the same acceptance path used by GitHub CI:

```sh
./scripts/run-ci.sh
```

It first verifies the documented fresh-clone `npm link` flow from a clean temporary copy, then runs the locked install, lint/typecheck/tests, build, and CLI version smoke test.

## 0.1.0 scope

SwitchYard 0.1.0 is Pi-first, tmux-first, local-only, and targets Linux and macOS. The intended 0.1.0 scope includes Git worktrees, durable task state, steering, decisions, and restart recovery.

## Design

Agents reason; SwitchYard coordinates. tmux hosts workers, durable state owns lifecycle, and each task gets an isolated Git worktree. Maintainers should use `AGENTS.md` for repository guidance and `CONTEXT.md` for canonical domain terminology.
