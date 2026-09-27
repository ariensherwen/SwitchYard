# Preserve task-owned workspaces

A Task's workspace must survive worker failure and cancellation until cleanup has positively established that no unlanded work would be lost.

# Keep task lifecycle explicit

Task state changes must use the canonical lifecycle and must not be inferred from arbitrary terminal text or prose.

# Keep tmux non-authoritative

tmux pane contents may be used for visibility or fallback diagnostics but must not override structured Pi or persisted SwitchYard state.

# Keep worker authority scoped

Worker code must not gain supervisor-only lifecycle, cross-task, destructive cleanup, or administrative authority.

# Persist steering before delivery

Worker steering and decision answers must be durably recorded before they are considered delivered once those features exist.

# Keep shell out of the domain model

Shell scripts and command strings must not own task lifecycle, recovery policy, authorization, or durable state.

# Do not add speculative runtime abstractions

Do not introduce generic agent, terminal, runtime, or backend interfaces until real variation or a concrete test seam requires them.

# Preserve version authority

The package version must come from package.json; do not add independent version constants.

# Cover behavioral changes

Any change to task, worker, workspace, recovery, messaging, or cleanup behavior must include focused regression coverage through the production interface.

# Keep root documentation lean

README.md, AGENTS.md, CONTEXT.md, and pi-warden.md must not duplicate implementation details already owned by code, tests, schemas, or another canonical document.
