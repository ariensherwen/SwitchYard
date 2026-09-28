# Project

SwitchYard is a Pi-first, tmux-first local orchestration control plane using durable SQLite state and task-owned Git worktrees.

# Scope

Build for Pi, tmux, Git worktrees, SQLite, TypeScript/Node.js, Linux, and macOS. Do not introduce generic agent, terminal, runtime, forge, workspace, or review-provider abstractions until real variation exists.

# Domain

`CONTEXT.md` is the canonical glossary and lifecycle contract. Keep Task state changes behind domain operations; callers must not assign lifecycle state ad hoc.

# Design rules

- Runtime code owns lifecycle invariants; prompts do not.
- Persist Messages, Decision answers, Findings, and state transitions before delivery.
- State transitions use compare-and-set semantics and pair with Events in the same transaction.
- A Task Workspace belongs to the Task and survives Worker replacement or cancellation.
- Pi role extensions must preserve authority separation.
- Review certification is bound to the current candidate SHA and a clean isolated review checkout.
- Recovery must use normal domain operations where possible and must never resurrect terminal Tasks.
- tmux hosts processes and provides visibility; terminal text is not authoritative state.
- Cleanup must positively prove that no unlanded work will be destroyed.

# Workflow

```sh
./scripts/run-ci.sh
```

Run CI locally through this script. Do not add or depend on GitHub Actions CI.

For real Pi/tmux acceptance:

```sh
SWITCHYARD_LIVE=1 ./scripts/run-live-e2e.sh
```

# Documentation

Keep root documentation lean. `README.md` is the user entry point, `CONTEXT.md` owns terminology/invariants, and `pi-warden.md` contains independently enforceable rules. Do not add roadmap dumps or speculative architecture manuals.
