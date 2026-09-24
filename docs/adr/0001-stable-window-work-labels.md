# Stable window work labels

Status: Accepted. Implemented. Date: 2026-09-23.

## Context

The baseline was SPEC.md v3, which this revises; SPEC.md has since been
updated to match. SPEC.md
treats Task as closely tied to recent screen content and does not define how
long an accepted label survives, when it may be replaced, or what explicit
commands do to it. This ADR fixes the meaning and lifecycle of the Task and
Name Record so automation cannot silently overwrite a user's assigned work.
Evidence and trigger rules for reaching acceptance are covered separately in
[ADR 0002](./0002-work-label-inference-policy.md); default display and the
upgrade migration are covered in
[ADR 0003](./0003-work-label-display-and-migration.md).

## Decision

**Task meaning.** A Task identifies a broad work goal spanning investigation,
design, implementation, and validation, not the current step. It belongs to
the whole Window, not its focused pane or an agent process.

**Automation may establish but never replace an accepted Task.** Once a Task
is accepted, automation may not replace it based on observed activity,
output, pane focus, process exit, or directory changes, including crossing a
Workspace boundary. Replacement requires an explicit user request
(re-identification or new work). Rationale: a potentially outdated label is
preferred over one that changes unexpectedly, since crossing a Workspace
boundary can be supporting work for the same Task, while a different Task can
begin within the same Workspace.

**Workspace-only name valid indefinitely.** Before a Task is established, a
Workspace-only name is valid indefinitely. Insufficient evidence must not be
turned into a speculative Task merely to complete the name.

**Name Record.** The Name Record is Scope plus Task; Scope is a Workspace
only (no Area; see [ADR 0003](./0003-work-label-display-and-migration.md) for
the full removal of Area from Scope and the Name Record). The Name Record is
stable once accepted, including its Workspace affiliation. Activity is not
part of it; it is live information observed separately and available in
diagnostics.

**Lifetime.** An accepted label lasts for the lifetime of the actual tmux
Window, surviving daemon restart, plugin upgrades, client detach/attach,
agent process exit, and window linking or movement between sessions. A newly
created Window starts afresh. No path-based recovery of closed-window labels
or identity matching across tmux-server reconstruction is planned.

**Re-identification (`refresh`).** Explicit re-identification retains the old
label until a replacement is accepted, including when inference fails or
abstains.

**New Work (`tmux-autoname new`).** `new` explicitly starts
new work in the target Window: it discards the old Task, shows the
Workspace-only name, and waits for new evidence rather than immediately
inferring from residual old screen content. Later failures do not restore the
discarded Task. It affects only the target Window and does not reset call
quotas. In manual mode it refuses the operation and asks the user to restore
automation first.

**Manual Name is untouched by either action.** Neither re-identification nor
`new` implicitly unlocks a Manual Name; restoring automation is a separate
ownership action. `auto` restores the saved automatic label without an AI
call, or returns to provisional naming if no accepted label exists.

**Duplicate labels.** Labels may be identical across Windows. Native tmux
window indices provide selection and disambiguation; the plugin does not
invent distinct Tasks, append collision suffixes, or rename existing labels
as other windows appear or disappear. Layouts hiding the native indices
cannot rely on label uniqueness.

**Task format.** Task remains a two-to-five-word lower-case English action
slug joined by hyphens; Workspace names retain their original spelling.
Automatic language detection and configurable task language are outside this
change.

## Consequences

Automation becomes more conservative: an outdated Task can persist after the
user has visibly moved on, until an explicit re-identification or new-work
command runs. This trades responsiveness for predictability, which is the
point of the change.

`new` is a new user-facing command. It is deliberately not called `reset`,
which would suggest clearing quotas or other state that it preserves.

SPEC.md / SPEC.zh-CN.md changes required at implementation:

- Section 4 (Name model): `Scope` drops the `area` field; `NameRecord`
  no longer carries `activity`. (Full removal detailed in
  [ADR 0003](./0003-work-label-display-and-migration.md).)
- Section 10 (AI trigger policy): add that automation may not
  replace an accepted Task; list Workspace-boundary crossing, pane focus,
  process exit, and directory change as explicit non-triggers once a Task is
  accepted.
- Section 13 (Manual ownership): note that re-identification and new
  work never unlock Manual Name; only `tmux rename-window ""` or
  `tmux-autoname auto` do.
- Section 17 (User-facing commands): add `tmux-autoname new` with
  the semantics above; there is no `reset` command.
