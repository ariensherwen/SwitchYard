# Bind review to the candidate

Review certification must bind to the Task's current candidate revision.

# Gate reviewed completion

A review-enabled Task must not complete without a clean Review of that candidate.

# Isolate reviewers

Reviewer processes must not modify or certify a modified Worker Workspace.

# Require structured completion

Worker completion must use SwitchYard's structured completion tool, never terminal prose.

# Persist before delivery

Messages and Decision answers must be durable before delivery is attempted.

# Preserve terminal state

Recovery must not resurrect completed, failed, or cancelled Tasks.

# Preserve role authority

No Pi role may receive tools belonging to a more privileged role.

# Preserve task work

Cancellation and Worker failure must not destroy a task-owned Workspace.

# Keep tmux non-authoritative

tmux pane contents must not override persisted SwitchYard state or structured Pi lifecycle events.
