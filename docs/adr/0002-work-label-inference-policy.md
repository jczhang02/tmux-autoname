# Work-label inference policy

Status: Superseded by ADR 0004. Date: 2026-09-23.

## Context

The baseline was SPEC.md v3, which this revises; SPEC.md has since been
updated to match. This ADR
covers what evidence may reach the model before a Task is accepted, what
triggers a pre-acceptance inference attempt, how the pre-acceptance Workspace
guess is chosen, and how rate limits and failure outcomes behave. It assumes
the Task lifecycle defined in
[ADR 0001](./0001-stable-window-work-labels.md): these rules govern only the
path to acceptance, since after acceptance automatic model calls stop.

## Decision

**Evidence limits.** Initial inference may use bounded terminal text only
from a pane that is both selected and visible in an attached client. Other
panes contribute local Workspace metadata only, never their rendered text. No
agent-private session files or hidden-pane text are read.

**Triggers before acceptance.** Another bounded automatic attempt is
justified only by materially changed, settled evidence, defined by reference
to SPEC.md section 10's evidence fingerprint and content-settle rules.
Elapsed time alone and repeated output alone never trigger an attempt. The
model may abstain. After a Task is accepted, automatic model calls stop
entirely.

**Pre-acceptance Workspace selection.** Before acceptance, the provisional
Workspace may follow Workspace changes but not subdirectory changes within a
Workspace. Selection prefers, in order: an explicit tmux session container
(project) whose name matches its root basename and whose root contains the
current directory; then the Git/worktree root; then the current directory as
a provisional fallback. Workspace affiliation is fixed when the Task is
accepted.

**Rate limits.** Automatic inference before acceptance keeps a default
minimum interval of 60 seconds, six requests per Window per hour, and thirty
requests per tmux server per hour. All outcomes -- success, abstention, and
failure -- consume budget. Explicit refresh bypasses the minimum interval but
not the hourly quotas. `new` and daemon restart do not clear quotas.

**Normal, non-error outcomes.** Missing AI configuration, insufficient
evidence, and quota exhaustion are normal provisional or unchanged outcomes,
not error badges; `explain` describes the reason and the next action.

**Real failure outcomes.** An actual request failure retains the existing
name and shows an error badge. A network failure does not automatically
resend identical evidence. Authentication or credential failure pauses
automatic attempts until an explicit refresh or `tmux-autoname secrets
reload` (SPEC.md sections 16 and 17); ordinary quota and circuit protections
still apply. Abstention is not an inference failure and does not contribute
to the failure circuit.

## Consequences

Restricting evidence to the visible, selected pane means multi-pane Windows
where the relevant work is happening in a background pane will not be named
from that pane's content until it is selected; this is an accepted tradeoff
against reading hidden or agent-private state.

Fixing Workspace affiliation at acceptance means a Task accepted while the
provisional Workspace guess was wrong will carry that wrong Workspace until
an explicit re-identification or new-work command runs.

SPEC.md / SPEC.zh-CN.md changes required at implementation:

- Section 7 (Evidence hierarchy): note that non-active panes
  contribute Workspace metadata only, never rendered text, consistent with
  the evidence-limits decision above.
- Section 8 (Scope candidate generation): restate the Workspace
  selection order (session container, then Git/worktree root, then cwd) as
  applying only before acceptance; Workspace affiliation is fixed at
  acceptance.
- Section 10 (AI trigger policy): replace "Scope crosses a Workspace
  or meaningful Area boundary" with "Workspace changes" as a trigger (Area is
  removed; see [ADR 0003](./0003-work-label-display-and-migration.md)); state
  that subdirectory changes within a Workspace never trigger; restrict all
  automatic triggers to Windows without an accepted Task; raise the minimum
  call interval from 10000 ms to 60 s; keep the 6-per-Window and
  30-per-server hourly quotas; state that success, abstention, and failure
  all consume budget.
- Section 11 (AI request and result): `NameProposalSchema` must let the
  model abstain as a distinct outcome from a Task proposal, and abstention
  must be excluded from the failure circuit (Section 14).
- Section 16 (Model provider and credentials): cross-reference that
  auth failure pausing automatic attempts is resolved by explicit refresh or
  `secrets reload`, matching the decision above.

## Resolved questions

**Evidence boundary after `new`.** At `new` time, the current evidence
fingerprint is recorded as a baseline. No automatic inference runs while the
fingerprint still equals that baseline; the next attempt requires changed,
settled evidence, so residual on-screen content from the discarded Task
cannot by itself trigger a fresh attempt.

**Concurrent observation.** Only the Window's active pane text is used, and
only while that Window is the current window of at least one attached
client. Other panes contribute local Workspace metadata only, never their
rendered text, consistent with the evidence-limits decision above.

**Stale in-flight inference.** Revision and fingerprint fencing (SPEC.md
section 12) is kept: `new`, manual rename, and refresh each increment the
revision, and a result whose revision or fingerprint no longer matches is
discarded. Once a Task is accepted, any other in-flight automatic request for
that Window is aborted or discarded.

**Explicit requests on hidden windows.** An explicit `refresh` (or a
keybinding invoking it) targeting a Window counts as consent to read that
Window's active pane text even when it is not currently visible; the read
stays bounded to that one pane.
