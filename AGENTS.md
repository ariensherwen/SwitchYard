# Project

SwitchYard is a Pi-first, tmux-first local coding-agent control plane. It supervises Pi workers in tmux, gives tasks isolated Git worktrees, and will persist durable task state locally.

# Current scope

Build for these concrete dependencies:

- Pi
- tmux
- Git worktrees
- SQLite
- Linux and macOS
- TypeScript/Node.js

Do not generalize around hypothetical future harnesses, terminals, workspace providers, or runtime backends. Add an abstraction only when real variation exists or an external dependency needs a deterministic test seam.

# Domain

`CONTEXT.md` is the canonical domain glossary. Use its terms and invariants instead of redefining Project, Task, Worker, Workspace, Supervisor, Message, Decision, Event, Pi session, or tmux session here.

# Design rules

- Prefer deep modules with small interfaces that own sequencing and invariants.
- Put seams around real variation only.
- Keep lifecycle state explicit and typed.
- Keep runtime correctness in code, not prompts.
- Treat tmux as process hosting and visibility, never authoritative semantic state.
- Keep shell commands thin; task lifecycle, recovery, authorization, and durable state belong in TypeScript.
- Preserve unlanded work. Cleanup must not destroy a task-owned workspace without proving it is safe.
- Use Pi TypeScript extensions for executable Pi integration when that integration lands.
- Test behavior through the same production interfaces used by the application.

# Workflow

```sh
./scripts/run-ci.sh
```

This is the local acceptance gate and should stay aligned with GitHub CI.

# Documentation

- Implementation and tests are authoritative for behavior.
- `CONTEXT.md` owns domain terminology and invariants.
- `README.md` is the human entry point.
- `pi-warden.md` contains enforcement rules only.
- Do not duplicate implementation walkthroughs into root documentation.
- Update documentation when public behavior or contracts change.

Keep root documentation lean. Do not add implementation history, roadmap dumps, or speculative architecture manuals.
